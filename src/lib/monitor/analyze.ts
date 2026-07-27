import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'
import { isPlayableVideoUrl } from './video-url'

const execFileAsync = promisify(execFile)

/** Frames are downscaled before base64 encoding — vision tokens scale with pixels. */
const FRAME_WIDTH = 512
/** ffmpeg scene score above which a frame boundary counts as a hard cut. */
const SCENE_THRESHOLD = 0.35
const MAX_VIDEO_BYTES = 40_000_000
/** Prevents ffmpeg hanging forever on HTML / corrupt downloads. */
const FF_TIMEOUT_MS = 45_000

function ff(
  cmd: string,
  args: string[],
  opts?: { maxBuffer?: number; timeout?: number },
) {
  return execFileAsync(cmd, args, {
    maxBuffer: opts?.maxBuffer,
    timeout: opts?.timeout ?? FF_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
}

export const SCENE_PROMPT_SYSTEM = `You are analyzing an Instagram Reel frame to generate a detailed image generation prompt.

Your goal: write a rich, detailed prompt so that AI can place a DIFFERENT person in the EXACT SAME scene — same angle, same setting, same pose, same outfit style.

You MUST describe all 4 elements with full detail:

1. CAMERA ANGLE (most important — be very precise):
   - Distance: close-up / medium shot / full body / waist-up / etc.
   - Angle: front-facing / 3/4 from left / side profile / slightly above / low angle / eye level / POV
   - Framing: centered / off-center / cropped at waist / etc.

2. SETTING & AMBIANCE (be specific):
   - Location: bedroom / outdoor park / beach / café / gym / car / street / etc.
   - Background: blurred / sharp / what's visible
   - Lighting: golden hour sunlight / soft window light / warm indoor lamp / harsh overhead / ring light glow / etc.
   - Overall mood: cozy / energetic / moody / bright / cinematic

3. POSE (describe precisely):
   - Body position and what person is doing
   - Arms/hands placement
   - Head tilt and direction of gaze

4. CLOTHING (describe everything visible):
   - Garment types, colors, style, fit
   - Visible accessories

RULES:
- DO NOT describe face features, hair color, skin tone, eye color, ethnicity
- DO include specific colors, textures, materials you can see
- Write minimum 80 words

OUTPUT: One flowing paragraph combining all 4 elements. Start with the camera angle.`

export async function extractVideoFrame(videoUrl: string, tag: string): Promise<string | null> {
  const videoPath = join(tmpdir(), `mon_vid_${tag}.mp4`)
  const framePath = join(tmpdir(), `mon_frame_${tag}.jpg`)
  try {
    const res = await fetch(videoUrl, {
      headers: { Range: 'bytes=0-5000000' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    writeFileSync(videoPath, Buffer.from(await res.arrayBuffer()))
    await ff('ffmpeg', [
      '-y', '-i', videoPath, '-ss', '1.5', '-vframes', '1', '-q:v', '2', framePath,
    ], { timeout: 20_000 })
    if (!existsSync(framePath)) return null
    return readFileSync(framePath).toString('base64')
  } catch {
    return null
  } finally {
    try { if (existsSync(videoPath)) unlinkSync(videoPath) } catch {}
    try { if (existsSync(framePath)) unlinkSync(framePath) } catch {}
  }
}

/** Measured properties of the source clip. Objective — no model inference involved. */
export interface SourceProbe {
  /** Evenly spaced JPEG frames as base64, first to last. */
  frames: string[]
  duration: number | null
  /** Hard cuts detected by ffmpeg scene scoring. 0 means one continuous shot. */
  cutCount: number
  /** Where those cuts fall, in seconds. Used to split the source into shots. */
  cutTimes: number[]
  hasAudio: boolean
}

async function downloadVideo(videoUrl: string, path: string): Promise<void> {
  if (!isPlayableVideoUrl(videoUrl)) {
    throw new Error(`not a direct video URL: ${videoUrl.slice(0, 80)}`)
  }
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(45_000) })
  if (!res.ok) throw new Error(`source video fetch failed: ${res.status}`)

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html')) {
    throw new Error('source URL returned HTML, not video')
  }

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_VIDEO_BYTES) throw new Error(`source video too large: ${declared} bytes`)

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error('source video is empty')
  if (buffer.byteLength > MAX_VIDEO_BYTES) throw new Error('source video too large')
  // Instagram HTML error pages are tiny; real reels are much larger.
  if (buffer.byteLength < 8_000) throw new Error('source download too small to be a video')

  writeFileSync(path, buffer)
}

async function probeFormat(path: string): Promise<{ duration: number | null; hasAudio: boolean }> {
  try {
    const { stdout } = await ff('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path,
    ], { timeout: 20_000 })
    const json = JSON.parse(stdout)
    const duration = parseFloat(json.format?.duration ?? '0')
    const hasAudio = (json.streams ?? []).some(
      (s: { codec_type?: string }) => s.codec_type === 'audio',
    )
    return { duration: duration > 0 ? duration : null, hasAudio }
  } catch {
    return { duration: null, hasAudio: false }
  }
}

/**
 * Timestamps of hard cuts via ffmpeg's scene score. The count alone is the most
 * decisive signal for technique routing — a clip with cuts cannot be reproduced
 * by any one-shot generation call — while the positions let the multi-shot path
 * split the source back into its individual shots.
 */
async function detectSceneCuts(path: string): Promise<number[]> {
  try {
    const { stderr } = await ff('ffmpeg', [
      '-i', path,
      '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      '-f', 'null', '-',
    ], { maxBuffer: 20_000_000, timeout: 60_000 })

    const times: number[] = []
    for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
      const t = parseFloat(m[1])
      if (Number.isFinite(t)) times.push(t)
    }
    return times.sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function extractFrameAt(path: string, seconds: number, outPath: string): Promise<string | null> {
  try {
    await ff('ffmpeg', [
      '-y', '-ss', seconds.toFixed(2), '-i', path,
      '-vframes', '1', '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '3', outPath,
    ], { timeout: 20_000 })
    if (!existsSync(outPath)) return null
    return readFileSync(outPath).toString('base64')
  } catch {
    return null
  }
}

/**
 * Downloads the clip once, then derives everything technique detection needs:
 * evenly spaced frames plus the measured duration, cut count and audio presence.
 */
export async function probeSourceVideo(
  videoUrl: string,
  frameCount = 5,
): Promise<SourceProbe | null> {
  const id = randomUUID()
  const videoPath = join(tmpdir(), `mon_probe_${id}.mp4`)
  const framePaths: string[] = []

  try {
    if (!isPlayableVideoUrl(videoUrl)) {
      console.warn('[monitor/probe] refusing page URL as video:', videoUrl.slice(0, 100))
      return null
    }
    await downloadVideo(videoUrl, videoPath)

    const { duration, hasAudio } = await probeFormat(videoPath)
    // No duration ⇒ not a real media file (e.g. HTML saved as .mp4) — skip heavy scene pass.
    if (duration == null) {
      console.warn('[monitor/probe] ffprobe found no duration — skipping cuts/frames')
      return null
    }
    const cutTimes = await detectSceneCuts(videoPath)

    // Without a duration we can only trust an early frame; seeking blind risks empty output.
    const span = duration ?? 3
    const first = Math.min(0.4, span * 0.05)
    const last = Math.max(first, span - 0.25)
    const step = frameCount > 1 ? (last - first) / (frameCount - 1) : 0

    const frames: string[] = []
    for (let i = 0; i < frameCount; i++) {
      const outPath = join(tmpdir(), `mon_probe_${id}_${i}.jpg`)
      framePaths.push(outPath)
      const frame = await extractFrameAt(videoPath, first + step * i, outPath)
      if (frame) frames.push(frame)
    }

    if (!frames.length) {
      console.warn('[monitor/probe] no frames extracted from', videoUrl.slice(0, 80))
      return null
    }
    return { frames, duration, cutCount: cutTimes.length, cutTimes, hasAudio }
  } catch (err) {
    // Callers fall back to thumbnail-only classification, which silently loses
    // technique detection — so make the reason visible.
    console.warn('[monitor/probe] failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    for (const p of [videoPath, ...framePaths]) {
      try { if (existsSync(p)) unlinkSync(p) } catch {}
    }
  }
}

export async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > 10_000_000) throw new Error('Image too large')
  return Buffer.from(buffer).toString('base64')
}

export async function extractScenePrompt(opts: {
  videoUrl?: string | null
  thumbnailUrl?: string | null
  tag: string
}): Promise<string> {
  let imageBase64: string | null = null

  if (opts.videoUrl) {
    imageBase64 = await extractVideoFrame(opts.videoUrl, opts.tag)
  }
  if (!imageBase64 && opts.thumbnailUrl) {
    imageBase64 = await fetchImageAsBase64(opts.thumbnailUrl)
  }
  if (!imageBase64) throw new Error('No image available for scene analysis')

  const prompt = await callGrok({
    model: GROK_SMART,
    messages: [{
      role: 'user',
      content: [
        base64ImageContent(imageBase64),
        { type: 'text', text: SCENE_PROMPT_SYSTEM },
      ],
    }],
    maxTokens: 2048,
    temperature: 0.4,
  })

  if (!prompt?.trim()) throw new Error('Empty scene prompt from Grok')
  return prompt.trim()
}

/** Scene description for a single frame, reusing the shared 4-element system prompt. */
export async function scenePromptFromFrame(frameBase64: string): Promise<string> {
  const prompt = await callGrok({
    model: GROK_SMART,
    messages: [{
      role: 'user',
      content: [
        base64ImageContent(frameBase64),
        { type: 'text', text: SCENE_PROMPT_SYSTEM },
      ],
    }],
    maxTokens: 2048,
    temperature: 0.4,
  })
  if (!prompt?.trim()) throw new Error('Empty scene prompt from Grok')
  return prompt.trim()
}

const END_FRAME_SUFFIX = `

IMPORTANT: this is the FINAL frame of a clip that began in a different state.
Describe this end state on its own terms, in full — do not reference the beginning
or use words like "now", "then", "has changed".`

/**
 * Start and end descriptions for a first_last_frame reproduction. Both frames get
 * their own standalone prompt so each generated keyframe is independently valid.
 */
export async function extractKeyframePrompts(probe: SourceProbe): Promise<{
  start: string
  end: string
}> {
  const firstFrame = probe.frames[0]
  const lastFrame = probe.frames[probe.frames.length - 1]
  if (!firstFrame || !lastFrame) throw new Error('Not enough frames for keyframe analysis')

  const start = await scenePromptFromFrame(firstFrame)
  const end = await callGrok({
    model: GROK_SMART,
    messages: [{
      role: 'user',
      content: [
        base64ImageContent(lastFrame),
        { type: 'text', text: SCENE_PROMPT_SYSTEM + END_FRAME_SUFFIX },
      ],
    }],
    maxTokens: 2048,
    temperature: 0.4,
  })
  if (!end?.trim()) throw new Error('Empty end-frame prompt from Grok')
  return { start, end: end.trim() }
}

const MOTION_PROMPT_SYSTEM = `You are given frames sampled in order from a short vertical Instagram Reel.

Write a DETAILED motion prompt for Seedance / image-to-video — director style, chronological, concrete verbs.

MUST cover, in order:
1. Main subject motion beat-by-beat (walk, lean, speak, wave, strike, etc.) with rough timing cues
2. EVERY other person — reactions and state changes
   (e.g. "young man bottom-left turns to camera biting his knuckles with a wide grin")
3. Whether any on-screen caption/meme text stays visible for the whole clip (quote it if readable)
4. Camera motion (static / push in / pull back / pan / handheld) and lighting stability
5. Secondary motion (hair, fabric strain, mic, crowd)

RULES:
- Do NOT describe face identity — only movement and reactions.
- Background gags are NOT optional if visible in any frame.
- Present tense. Prefer 4–8 dense sentences over a vague one-liner.
- End with: vertical 9:16, natural physically plausible motion.`

/** Motion description for image_to_video and extend techniques. */
export async function extractMotionPrompt(probe: SourceProbe): Promise<string> {
  const prompt = await callGrok({
    model: GROK_SMART,
    messages: [{
      role: 'user',
      content: [
        ...probe.frames.map(f => base64ImageContent(f)),
        { type: 'text', text: MOTION_PROMPT_SYSTEM },
      ],
    }],
    maxTokens: 900,
    temperature: 0.35,
  })
  if (!prompt?.trim()) throw new Error('Empty motion prompt from Grok')
  return prompt.trim()
}

export async function getFrameBase64(opts: {
  videoUrl?: string | null
  thumbnailUrl?: string | null
  tag: string
}): Promise<string> {
  if (opts.videoUrl) {
    const frame = await extractVideoFrame(opts.videoUrl, opts.tag)
    if (frame) return frame
  }
  if (opts.thumbnailUrl) return fetchImageAsBase64(opts.thumbnailUrl)
  throw new Error('No image available')
}
