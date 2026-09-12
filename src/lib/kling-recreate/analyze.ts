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

async function describeFrameChunk(
  frames: OneFpsExtract['frames'],
): Promise<FrameDescription[]> {
  const raw = await callGrok({
    model: GROK_SMART,
    json: true,
    temperature: 0.2,
    maxTokens: 4096,
    system:
      'You describe video frames for motion generation. Return JSON ' +
      '{"frames":[{"t":number,"description":"detailed what happens in this frame"}]} ' +
      'with one entry per image, in order. Describe subject, pose, wardrobe, ' +
      'hands, face, camera angle, background, lighting, motion cues.',
    messages: [{
      role: 'user',
      content: [
        ...frames.map(f => base64ImageContent(f.base64)),
        {
          type: 'text' as const,
          text:
            `These ${frames.length} frames are 1fps samples at t=` +
            `${frames.map(f => f.t_sec).join(', ')} seconds. Describe each frame.`,
        },
      ],
    }],
  })

  const parsed = parseJsonObject(raw)
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

async function synthesizeContext(opts: {
  frames: FrameDescription[]
  duration: number | null
  aspectRatio: string
  transcript: string
}): Promise<Pick<KlingVideoContext, 'setting' | 'character_action' | 'camera' | 'speech' | 'shots'> & { master_prompt: string }> {
  const timeline = opts.frames
    .map(f => `${f.t_sec.toFixed(0)}s: ${f.description}`)
    .join('\n')

  const raw = await callGrok({
    model: GROK_FAST,
    json: true,
    temperature: 0.25,
    maxTokens: 3072,
    system:
      'You write a master motion-generation prompt from a 1fps video analysis. ' +
      'Return JSON with setting, character_action, camera, speech (or null), ' +
      'master_prompt (one prose paragraph a video model can follow), and ' +
      'shots: array of {t_start, t_end, prompt} for distinct camera/action beats, max 6.',
    messages: [{
      role: 'user',
      content: [
        `Duration: ${opts.duration != null ? `${opts.duration.toFixed(1)}s` : 'unknown'}. Aspect: ${opts.aspectRatio}.`,
        opts.transcript ? `Transcript:\n${opts.transcript}` : 'No speech transcript.',
        `Per-frame descriptions:\n${timeline}`,
        'master_prompt must describe setting, character action, camera, and speech if any.',
      ].join('\n'),
    }],
  })

  const parsed = parseJsonObject(raw)
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
    character_action: String(parsed.character_action ?? '').trim(),
    camera: String(parsed.camera ?? '').trim(),
    speech: parsed.speech == null || parsed.speech === '' ? null : String(parsed.speech),
    shots,
    master_prompt: String(parsed.master_prompt ?? '').trim(),
  }
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
    frames.push(...await describeFrameChunk(chunk))
  }

  let transcript = ''
  if (extract.hasAudio) {
    try {
      transcript = (await transcribeSourceSpeech(videoUrl)).text
    } catch (err) {
      console.warn('[kling-recreate] transcript failed:', err instanceof Error ? err.message : err)
    }
  }

  const synthesized = await synthesizeContext({
    frames,
    duration: extract.duration,
    aspectRatio: extract.aspectRatio,
    transcript,
  })

  const shots = synthesized.shots
  const context: KlingVideoContext = {
    setting: synthesized.setting,
    character_action: synthesized.character_action,
    camera: synthesized.camera,
    speech: synthesized.speech ?? (transcript || null),
    duration_sec: extract.duration,
    aspect_ratio: extract.aspectRatio,
    shots,
    prompt_mode: choosePromptMode(shots),
  }

  const master_prompt = synthesized.master_prompt
    || [
      context.setting,
      context.character_action,
      context.camera,
      context.speech,
      frames.map(f => f.description).join(' '),
    ].filter(Boolean).join(' ')

  return { frames, context, master_prompt }
}

export function renderRecreateKeyframePrompt(context: KlingVideoContext): string {
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
  ].filter(Boolean).join(' ')
}
