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
  'You describe consecutive ~2fps video frames for a motion-generation model, one entry per frame, ' +
  'in strict chronological order. Return JSON {"frames":[{"t":number,"description":"..."}]}.\n\n' +
  'Each description must cover, explicitly, every time: HEAD/FACE (direction, expression, eyes open ' +
  'or closed — do not default to "eyes closed" out of habit, look at the actual frame), MOUTH/SPEECH ' +
  '(state plainly: mouth closed / mouth open not speaking, e.g. smiling or gasping / mouth actively ' +
  'moving as if speaking — this is used later to work out who said which line, so never skip it and ' +
  'never guess "speaking" just because a line falls near this timestamp), HANDS (what each hand is ' +
  'doing, holding, and exactly where it is), TORSO/HIPS, LEGS/FEET (weight-bearing leg, stride phase), ' +
  'and WARDROBE state (any garment moved by wind, motion, or the subject\'s own hands since the last ' +
  'frame). If more than one person is visible, describe MOUTH/SPEECH for each of them separately, ' +
  'not just the main subject.\n\n' +
  'CRITICAL — this is a SEQUENCE, not a set of unrelated stills: for every frame after the first, ' +
  'state what changed from the previous frame first, then the rest of the description. If two ' +
  'consecutive frames genuinely look identical, say so explicitly ("unchanged from previous frame in ' +
  'pose/hands/face; only X differs") — do not silently paste the same boilerplate sentence for both, ' +
  'that is the single most common failure mode and it destroys the sequence. Real ~2fps footage of a ' +
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
            `These ${frames.length} frames are ~2fps samples at t=${frames.map(f => f.t_sec.toFixed(1)).join(', ')} seconds, in order.`,
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
 * A 10s clip sampled at ~2fps has ~20 frame-level observations; this step's
 * job is to compress those into at most 6 shots WITHOUT losing the specific,
 * differentiated motion each frame already captured — the previous version
 * of this prompt let the model default to a generic paraphrase instead,
 * which is what made the output "raw" (confirmed by the user reviewing a
 * real master_prompt live, 2026-09-16): vague verbs ("speaks flirtatiously"),
 * no reason WHY the clip works, and shots that don't actually track distinct
 * body-part changes frame to frame.
 */
const SYNTHESIS_SYSTEM =
  'You compress a ~2fps, per-frame video analysis into instructions for a video-generation model. ' +
  'Return JSON: setting, hook, character_action, camera, speech (or null), capture_style ' +
  '("produced" or "phone"), master_prompt, ' +
  'shots: array of {t_start, t_end, prompt}, at most 6 entries, covering the FULL clip start to end ' +
  'with no gaps.\n\n' +
  'capture_style — FIRST decide the capture device: is this ACTUALLY real broadcast/film equipment ' +
  '(rare — only for genuine TV-show footage with real multicam production value, studio lighting rigs, ' +
  'and broadcast-grade sharpness/dynamic range) or phone/consumer-camera footage (the default for nearly ' +
  'all short-form social content, even when scripted as a skit/prank/interview bit — most "sitcom-style" ' +
  'or "talk-show style" reels are still shot handheld or on a tripod with a phone, not with real studio ' +
  'cameras). Answer "produced" only when the source frames genuinely show an actual TV production ' +
  '(audience risers, broadcast desk hardware, network-grade lighting rig). Otherwise answer "phone". ' +
  'Never default to "produced" just because the content is scripted or sitcom-style — scripted does not ' +
  'mean professionally shot.\n\n' +
  'SAFE WORDING (this text feeds an image-edit model with a strict content filter that rejects specific ' +
  'trigger words regardless of context) — this applies to setting, character_action, and every shot ' +
  'prompt: NEVER use "corset", "bustier", "lace-up", "cleavage", "plunging" (neckline), "sheer", ' +
  '"thigh-high", "choker", or any other lingerie/fetish-coded term, no matter how the source frame looks. ' +
  'Describe wardrobe by silhouette/color/style/costume-type instead — e.g. "a form-fitting black ' +
  'bodice-style costume with white trim" not "a black lace bustier with a plunging neckline". Do not ' +
  'describe skin exposure or cleavage at all; describe the garment, not what it reveals. For any beat ' +
  'involving physical contact (a kiss, an embrace), describe the PRE-contact framing only ("faces close ' +
  'together, about to kiss") — never mid/post-contact lip or body contact description. If any card, sign, ' +
  'screen, notepad, or other flat surface that could carry text/logo appears in the setting or a shot, ' +
  'describe it as blank/plain ("blank light-blue index card, no text, no logo") — never invent or imply ' +
  'real network/brand branding, the image model will hallucinate one otherwise.\n\n' +
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
  'are for), say what changed. Merge only genuinely identical seconds; do not merge for brevity. Every ' +
  'shot must refer to the on-camera subject as the same one continuous person, appearance matching the ' +
  'reference photo used to generate the still image this shot is anchored to — do not describe her as if ' +
  'she could be a different person shot to shot.\n\n' +
  'SPEECH ATTRIBUTION (CRITICAL — this pipeline previously put the wrong person\'s words in the wrong ' +
  'mouth, confirmed live 2026-09-16, do not repeat that): the transcript is timestamped as ' +
  '"[start s-end s] text". For each line, find the per-frame description(s) whose time falls inside ' +
  'that window and check what MOUTH/SPEECH says for every visible person at that moment.\n' +
  '- Attribute the line to a visible person ONLY if their mouth is described as actively moving/speaking ' +
  'at that timestamp.\n' +
  '- If the frame data shows the main subject\'s mouth closed or just smiling (not speaking) at that ' +
  'timestamp, that line is NOT hers — phrase it as heard off-screen instead (e.g. "a voice off-camera ' +
  'says ..."), never put it in her mouth by default.\n' +
  '- A back-and-forth transcript (two distinct voices/registers) with only one person ever visibly ' +
  'speaking means the other voice is off-screen for its lines — never assign both sides to the one ' +
  'visible person.\n' +
  '- When genuinely unsure, phrase the line as off-screen/ambient rather than guessing a speaker — a line ' +
  'not visually lip-synced is harmless, a line put in the wrong (or same) mouth for both speakers is not.\n' +
  '- State each line within the shot whose time range it falls in, quoted, correctly attributed per the ' +
  'rule above.\n\n' +
  'master_prompt — one flowing paragraph (not a list), a fallback for when shots are not used: setting, ' +
  'hook, the full character_action, camera, and speech.\n\n' +
  'Never use "steadily", "smoothly", "gently", "calmly", "consistently", "playfully", "flirtatiously", ' +
  'or "dynamically" as a substitute for describing what actually happens — name the phase/action/words ' +
  'instead. Do not invent anything not present in the per-frame descriptions or transcript. Precision and ' +
  'natural prose are both required — a mechanical checklist is not more precise, it is just worse writing.\n\n' +
  'MANUAL CONTEXT (optional, may be given below): a loose, informal note from the person requesting this ' +
  'recreation — sometimes dictated from memory or a quick voice note, possibly in Serbian, possibly with ' +
  'the dialogue attributed to the wrong speaker or shots out of order. Use it only as a hint for what to ' +
  'expect (the general idea, roughly which lines go where) — the per-frame descriptions and any real audio ' +
  'transcript above are ground truth and OVERRIDE it whenever they conflict (same priority rule as speech ' +
  'attribution above: trust what the frames/transcript actually show, not what the note assumed). Never ' +
  'copy Serbian words into your output — translate the gist into English only where it helps interpret ' +
  'ambiguous framing or dialogue.'

async function synthesizeContext(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
  manualContext?: string | null
}): Promise<Pick<KlingVideoContext, 'setting' | 'hook' | 'character_action' | 'camera' | 'speech' | 'shots' | 'capture_style'> & { master_prompt: string }> {
  const timeline = opts.frames
    .map(f => `${f.t_sec.toFixed(1)}s: ${f.description}`)
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
        opts.manualContext?.trim() ? `Manual context (see rules above for priority): ${opts.manualContext.trim()}` : '',
        opts.transcript ? `Timestamped transcript:\n${opts.transcript}` : 'No speech transcript.',
        `Per-frame descriptions (~2fps, already tracks what changed each moment):\n${timeline}`,
        'Follow the rules above exactly. Cross-check before returning: does character_action name ' +
          'every distinct beat visible in the per-frame timeline? Do shots cover 0s to the end with no ' +
          'gap and no repeated pose between consecutive shots? If not, fix it before returning.',
      ].filter(Boolean).join('\n'),
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

  const captureStyle = parsed.capture_style === 'produced' ? 'produced' : 'phone'

  return {
    setting: String(parsed.setting ?? '').trim(),
    hook: String(parsed.hook ?? '').trim(),
    character_action: String(parsed.character_action ?? '').trim(),
    camera: String(parsed.camera ?? '').trim(),
    speech: parsed.speech == null || parsed.speech === '' ? null : String(parsed.speech),
    shots,
    capture_style: captureStyle,
    master_prompt: String(parsed.master_prompt ?? '').trim(),
  }
}

async function buildAnalysisFromFrames(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
  manualContext?: string | null
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
    capture_style: synthesized.capture_style,
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
  manualContext?: string | null,
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
    frames, duration: extract.duration, aspectRatio: extract.aspectRatio, transcript, manualContext,
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
  manualContext?: string | null
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
