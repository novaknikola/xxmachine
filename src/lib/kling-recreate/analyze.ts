import { callGrok, GROK_SMART, GROK_FAST, base64ImageContent } from '@/lib/grok'
import { KEYFRAME_IDENTITY_LOCK, transcribeSourceSpeech } from '@/lib/monitor/copy-paste-spec'
import type { OneFpsExtract } from './frames'
import type { KlingShotBeat, KlingVideoContext } from './types'

const CHUNK = 12

export interface FrameDescription {
  t_sec: number
  description: string
}

export interface KlingAnalysis {
  frames: FrameDescription[]
  context: KlingVideoContext
  master_prompt: string
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch { /* fall through */ }
  throw new Error('Kling analysis JSON parse failed')
}

/**
 * This pipeline chains several Grok calls per job (one per frame chunk, plus
 * synthesizeContext) where Copy-Paste v2 makes one — so a single malformed
 * response has more chances to kill the whole job. One retry on a bad parse
 * (re-asking, not re-parsing the same text) absorbs an occasional bad turn.
 */
async function callGrokJson(opts: Parameters<typeof callGrok>[0]): Promise<Record<string, unknown>> {
  try {
    return parseJsonObject(await callGrok(opts))
  } catch {
    return parseJsonObject(await callGrok(opts))
  }
}

/**
 * Words that describe a moving body without saying what actually changed —
 * banned for the same reason Copy-Paste's spec (copy-paste-spec.ts RULE E)
 * bans them: they instruct a video model to damp the exact motion it was
 * asked to reproduce, and they let a lazy per-frame description get away
 * with repeating itself instead of tracking a real change.
 */
const FRAME_DESCRIPTION_SYSTEM =
  'You describe consecutive 1fps video frames for a motion-generation model, one entry per frame, ' +
  'in strict chronological order. Return JSON {"frames":[{"t":number,"description":"..."}]}.\n\n' +
  'Each description must cover, explicitly, every time: HEAD/FACE (direction, expression, eyes open ' +
  'or closed — do not default to "eyes closed" out of habit, look at the actual frame), HANDS (what ' +
  'each hand is doing, holding, and exactly where it is), TORSO/HIPS, LEGS/FEET (weight-bearing leg, ' +
  'stride phase), and WARDROBE state (any garment moved by wind, motion, or the subject\'s own hands ' +
  'since the last frame).\n\n' +
  'CRITICAL — this is a SEQUENCE, not a set of unrelated stills: for every frame after the first, ' +
  'state what changed from the previous frame first, then the rest of the description. If two ' +
  'consecutive frames genuinely look identical, say so explicitly ("unchanged from previous frame in ' +
  'pose/hands/face; only X differs") — do not silently paste the same boilerplate sentence for both, ' +
  'that is the single most common failure mode and it destroys the sequence. Real 1fps footage of a ' +
  'person almost never has ten identical "eyes closed, smiling" frames in a row; if your descriptions ' +
  'read that way, you are pattern-matching a generic pose instead of looking at each image.\n\n' +
  'Never use "steadily", "smoothly", "gently", "calmly", "consistently", or "slightly" to describe ' +
  'motion — name the actual phase instead (e.g. "right foot lands, weight shifting forward" not ' +
  '"walks smoothly"). Also note camera angle/framing and background only insofar as they change.'

async function describeFrameChunk(
  frames: OneFpsExtract['frames'],
  precedingContext: string | null,
): Promise<FrameDescription[]> {
  const parsed = await callGrokJson({
    model: GROK_SMART,
    json: true,
    temperature: 0.2,
    maxTokens: 4096,
    system: FRAME_DESCRIPTION_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        ...frames.map(f => base64ImageContent(f.base64)),
        {
          type: 'text' as const,
          text: [
            `These ${frames.length} frames are 1fps samples at t=${frames.map(f => f.t_sec).join(', ')} seconds, in order.`,
            precedingContext
              ? `The frame immediately before this chunk (last one already described) ended like this — start this chunk's first frame by stating what changed from it: ${precedingContext}`
              : 'This is the first frame of the clip — describe it fully, nothing precedes it.',
            'Describe each frame per the rules above. One entry per image, same order.',
          ].filter(Boolean).join(' '),
        },
      ],
    }],
  })
  const list = Array.isArray(parsed.frames) ? parsed.frames : []
  return frames.map((f, i) => {
    const rec = (list[i] ?? {}) as { t?: unknown; description?: unknown }
    const description = String(rec.description ?? '').trim()
    return {
      t_sec: f.t_sec,
      description: description || `Frame at ${f.t_sec}s`,
    }
  })
}

function choosePromptMode(shots: KlingShotBeat[]): 'prompt' | 'multi_prompt' {
  return shots.length >= 2 && shots.length <= 6 ? 'multi_prompt' : 'prompt'
}

/**
 * Kling's own multi_prompt API caps at 6 beats (KLING_MULTI_PROMPT_MAX in
 * kling-client.ts) — a hard provider limit, not something prompting can lift.
 * A 10s clip sampled at 1fps has ~10 frame-level observations; this step's
 * job is to compress those into at most 6 shots WITHOUT losing the specific,
 * differentiated motion each frame already captured — the previous version
 * of this prompt let the model default to a generic paraphrase instead,
 * which is what made the output "raw" (confirmed by the user reviewing a
 * real master_prompt live, 2026-09-16): vague verbs ("speaks flirtatiously"),
 * no reason WHY the clip works, and shots that don't actually track distinct
 * body-part changes frame to frame.
 */
const SYNTHESIS_SYSTEM =
  'You compress a 1fps, per-frame video analysis into instructions for a video-generation model. ' +
  'Return JSON: setting, hook, character_action, camera, speech (or null), master_prompt, ' +
  'shots: array of {t_start, t_end, prompt}, at most 6 entries, covering the FULL clip start to end ' +
  'with no gaps.\n\n' +
  'hook — ONE sentence: the specific reason this clip works, the actual point of the action and ' +
  'dialogue together, stated as a concrete fact (what is being said/implied and what physical action ' +
  'it goes with) — never a mood word like "flirty" or "playful" standing in for the actual content. ' +
  'If the transcript is a back-and-forth or a joke, say what the joke/exchange actually is.\n\n' +
  'character_action — the complete action from the FIRST second to the LAST, in order, naming every ' +
  'distinct beat (not just the overall gist), written as ONE flowing narrative sentence-by-sentence ' +
  'description — not a checklist. If the per-frame descriptions show 6 different things happening ' +
  'across the clip, character_action must name all 6, not summarize them into 1-2.\n\n' +
  'shots — this is the part that actually reaches the video model, so it carries the most weight, and ' +
  'HOW it is written matters as much as WHAT it says. Each shot.prompt must read like natural director\'s ' +
  'direction — 2-4 flowing sentences of prose, the way a person would describe the beat out loud — built ' +
  'from the concrete details in the per-frame descriptions for its time range, but REWRITTEN as narrative, ' +
  'never copied as a list. Do NOT structure every shot the same mechanical way (e.g. "Head: ... Eyes: ... ' +
  'Right hand: ... Left hand: ... Torso: ..." repeated shot after shot) — that pattern reads as a robotic ' +
  'pose audit, not direction, even when the underlying details are accurate, and it produces worse motion ' +
  'than a natural sentence would. Only mention a body part when it is doing something worth directing; ' +
  'skip the ones that are just sitting there. Two consecutive shots must never describe the same pose/' +
  'action — if the per-frame timeline shows real change between them (it should, that is what the frames ' +
  'are for), say what changed. Merge only genuinely identical seconds; do not merge for brevity. State ' +
  'speech within the shot whose time range it falls in, quoted, with who says it if determinable.\n\n' +
  'master_prompt — one flowing paragraph (not a list), a fallback for when shots are not used: setting, ' +
  'hook, the full character_action, camera, and speech.\n\n' +
  'Never use "steadily", "smoothly", "gently", "calmly", "consistently", "playfully", "flirtatiously", ' +
  'or "dynamically" as a substitute for describing what actually happens — name the phase/action/words ' +
  'instead. Do not invent anything not present in the per-frame descriptions or transcript. Precision and ' +
  'natural prose are both required — a mechanical checklist is not more precise, it is just worse writing.'

async function synthesizeContext(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
}): Promise<Pick<KlingVideoContext, 'setting' | 'hook' | 'character_action' | 'camera' | 'speech' | 'shots'> & { master_prompt: string }> {
  const timeline = opts.frames
    .map(f => `${f.t_sec.toFixed(0)}s: ${f.description}`)
    .join('\n')

  const parsed = await callGrokJson({
    model: GROK_FAST,
    json: true,
    temperature: 0.25,
    maxTokens: 4096,
    system: SYNTHESIS_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `Duration: ${opts.duration != null ? `${opts.duration.toFixed(1)}s` : 'unknown'}. Aspect: ${opts.aspectRatio}.`,
        opts.transcript ? `Timestamped transcript:\n${opts.transcript}` : 'No speech transcript.',
        `Per-frame descriptions (1fps, already tracks what changed each second):\n${timeline}`,
        'Follow the rules above exactly. Cross-check before returning: does character_action name ' +
          'every distinct beat visible in the per-frame timeline? Do shots cover 0s to the end with no ' +
          'gap and no repeated pose between consecutive shots? If not, fix it before returning.',
      ].join('\n'),
    }],
  })
  const shotsRaw = Array.isArray(parsed.shots) ? parsed.shots : []
  const shots: KlingShotBeat[] = shotsRaw
    .map((s): KlingShotBeat | null => {
      if (!s || typeof s !== 'object') return null
      const rec = s as { t_start?: unknown; t_end?: unknown; prompt?: unknown }
      const prompt = String(rec.prompt ?? '').trim()
      if (!prompt) return null
      return {
        t_start: Number(rec.t_start) || 0,
        t_end: Number(rec.t_end) || 0,
        prompt,
      }
    })
    .filter((s): s is KlingShotBeat => s !== null)
    .slice(0, 6)

  return {
    setting: String(parsed.setting ?? '').trim(),
    hook: String(parsed.hook ?? '').trim(),
    character_action: String(parsed.character_action ?? '').trim(),
    camera: String(parsed.camera ?? '').trim(),
    speech: parsed.speech == null || parsed.speech === '' ? null : String(parsed.speech),
    shots,
    master_prompt: String(parsed.master_prompt ?? '').trim(),
  }
}

async function buildAnalysisFromFrames(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
}): Promise<KlingAnalysis> {
  const synthesized = await synthesizeContext(opts)

  const shots = synthesized.shots
  const context: KlingVideoContext = {
    setting: synthesized.setting,
    hook: synthesized.hook,
    character_action: synthesized.character_action,
    camera: synthesized.camera,
    speech: synthesized.speech ?? (opts.transcript || null),
    duration_sec: opts.duration,
    aspect_ratio: opts.aspectRatio,
    shots,
    prompt_mode: choosePromptMode(shots),
  }

  const master_prompt = synthesized.master_prompt
    || [
      context.setting,
      context.hook,
      context.character_action,
      context.camera,
      context.speech,
      opts.frames.map(f => f.description).join(' '),
    ].filter(Boolean).join(' ')

  return { frames: opts.frames, context, master_prompt }
}

export async function analyzeOneFpsVideo(
  extract: OneFpsExtract,
  videoUrl: string,
): Promise<KlingAnalysis> {
  const chunks: OneFpsExtract['frames'][] = []
  for (let i = 0; i < extract.frames.length; i += CHUNK) {
    chunks.push(extract.frames.slice(i, i + CHUNK))
  }

  const frames: FrameDescription[] = []
  for (const chunk of chunks) {
    // Each chunk gets the last frame's description from the PREVIOUS chunk so
    // "what changed" tracking doesn't reset at chunk boundaries (CHUNK=12
    // frames per call) — otherwise the first frame of every new chunk reads
    // like the start of a new sequence instead of a continuation.
    const preceding = frames.length ? frames[frames.length - 1].description : null
    frames.push(...await describeFrameChunk(chunk, preceding))
  }

  let transcript = ''
  if (extract.hasAudio) {
    try {
      transcript = (await transcribeSourceSpeech(videoUrl)).text
    } catch (err) {
      console.warn('[kling-recreate] transcript failed:', err instanceof Error ? err.message : err)
    }
  }

  return buildAnalysisFromFrames({
    frames, duration: extract.duration, aspectRatio: extract.aspectRatio, transcript,
  })
}

/**
 * Re-synthesizes shots/master_prompt off ALREADY-EXTRACTED per-frame
 * descriptions — used by the "Regenerate prompt" action so a rejected shot
 * breakdown can be redone without re-spending on the per-frame Grok vision
 * pass (that part is the more expensive one and wasn't what was wrong).
 */
export async function analyzeOneFpsVideoFromFrames(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
}): Promise<KlingAnalysis> {
  return buildAnalysisFromFrames(opts)
}

export function renderRecreateKeyframePrompt(
  context: KlingVideoContext,
  customPrompt?: string | null,
): string {
  return [
    'Image 1 is the scene reference, image 2 is the identity reference.',
    'Keep the exact pose, camera framing, and background from image 1 unchanged.',
    "Replace the main subject's face and body identity with the person from image 2.",
    context.setting && `Environment: ${context.setting}.`,
    context.camera && `Camera: ${context.camera}.`,
    `Body and skin come from image 2, not image 1: ${KEYFRAME_IDENTITY_LOCK}.`,
    'Preserve any motion blur, hair displacement, cloth movement and body lean present in image 1 — do not straighten the pose.',
    'Remove any on-screen text, captions, subtitles, or watermarks visible in image 1.',
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
    // User-supplied, collected before the still is generated (Telegram "Add
    // prompt?" step) — appended last so it can override/refine the defaults
    // above without fighting for priority against the identity-lock rules.
    customPrompt?.trim() ? customPrompt.trim() : '',
  ].filter(Boolean).join(' ')
}
