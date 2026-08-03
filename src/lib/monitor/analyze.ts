import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { isPlayableVideoUrl } from './video-url'
import { uploadBuffer } from '@/lib/supabase-storage'

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

export type SourceAspectRatio = '9:16' | '16:9' | '1:1' | 'other'

/** Measured properties of the source clip. Objective — no model inference involved. */
export interface SourceProbe {
  /** Evenly spaced JPEG frames as base64, first to last. */
  frames: string[]
  /**
   * Seconds into the clip each frame was taken, aligned with `frames`. Lets the
   * vision model line a spoken line up against whether the visible subject's
   * mouth was actually moving at that moment.
   */
  frameTimes: number[]
  duration: number | null
  /** Hard cuts detected by ffmpeg scene scoring. 0 means one continuous shot. */
  cutCount: number
  /** Where those cuts fall, in seconds. */
  cutTimes: number[]
  hasAudio: boolean
  width: number | null
  height: number | null
  aspectRatio: SourceAspectRatio
  /** Frame 0 (always ≤0.4s in) re-hosted publicly — the Seedream Edit keyframe input. Best-effort. */
  firstFrameUrl: string | null
  /** Last sampled frame (~0.25s before the end) — input for the optional end keyframe. Best-effort. */
  lastFrameUrl: string | null
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

function bucketAspectRatio(width: number | null, height: number | null): SourceAspectRatio {
  if (!width || !height) return 'other'
  const ratio = width / height
  const candidates: Array<{ label: SourceAspectRatio; value: number }> = [
    { label: '9:16', value: 9 / 16 },
    { label: '16:9', value: 16 / 9 },
    { label: '1:1', value: 1 },
  ]
  const TOLERANCE = 0.08
  let best: { label: SourceAspectRatio; diff: number } | null = null
  for (const c of candidates) {
    const diff = Math.abs(ratio - c.value)
    if (diff <= TOLERANCE && (!best || diff < best.diff)) best = { label: c.label, diff }
  }
  return best?.label ?? 'other'
}

async function probeFormat(path: string): Promise<{
  duration: number | null
  hasAudio: boolean
  width: number | null
  height: number | null
}> {
  try {
    const { stdout } = await ff('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path,
    ], { timeout: 20_000 })
    const json = JSON.parse(stdout)
    const duration = parseFloat(json.format?.duration ?? '0')
    const streams = (json.streams ?? []) as Array<{
      codec_type?: string
      width?: number
      height?: number
    }>
    const hasAudio = streams.some(s => s.codec_type === 'audio')
    const videoStream = streams.find(s => s.codec_type === 'video')
    return {
      duration: duration > 0 ? duration : null,
      hasAudio,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
    }
  } catch {
    return { duration: null, hasAudio: false, width: null, height: null }
  }
}

/**
 * Timestamps of hard cuts via ffmpeg's scene score. Positions let the
 * multi-shot path split the source back into its individual shots.
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
 * Downloads the clip once, then derives everything Copy-Paste needs:
 * evenly spaced frames plus measured duration, dimensions/aspect ratio,
 * cut count and audio presence.
 */
/**
 * Frame sampling is adaptive, because a fixed count means the gap between
 * frames grows with the clip: eight frames covered a 10s reel every ~1.3s but
 * a 20s one only every ~2.8s, and anything happening between two samples is
 * invisible to the analyser. Aiming at a constant gap keeps long reels as
 * legible as short ones.
 *
 * The floor keeps short clips exactly where they were; the ceiling caps what a
 * single vision call has to carry.
 */
const TARGET_FRAME_GAP_SEC = 1.2
const MAX_PROBE_FRAMES = 20

/**
 * @param minFrames floor — duration may push the real count above it.
 * @param lineTimes extra moments worth a frame, on top of the even grid.
 *   Speech attribution has to judge whether a mouth is moving *at the moment a
 *   line was spoken*, and an evenly spaced grid lands wherever it lands. Adding
 *   the transcript's own timings puts a frame where the question is asked.
 */
export async function probeSourceVideo(
  videoUrl: string,
  minFrames = 5,
  lineTimes: number[] = [],
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

    const { duration, hasAudio, width, height } = await probeFormat(videoPath)
    // No duration ⇒ not a real media file (e.g. HTML saved as .mp4) — skip heavy scene pass.
    if (duration == null) {
      console.warn('[monitor/probe] ffprobe found no duration — skipping cuts/frames')
      return null
    }
    const cutTimes = await detectSceneCuts(videoPath)

    const span = duration ?? 3
    const frameCount = Math.min(
      MAX_PROBE_FRAMES,
      Math.max(minFrames, Math.ceil(span / TARGET_FRAME_GAP_SEC)),
    )
    const first = Math.min(0.4, span * 0.05)
    const last = Math.max(first, span - 0.25)
    const step = frameCount > 1 ? (last - first) / (frameCount - 1) : 0

    const grid = Array.from({ length: frameCount }, (_, i) => first + step * i)

    // Merge the transcript's moments into the grid, dropping any that already
    // have a frame within half the grid spacing — a near-duplicate costs a
    // vision-call image slot and tells the model nothing new.
    const tooClose = Math.max(0.25, step / 2)
    const extra = lineTimes
      .filter(t => Number.isFinite(t) && t > first && t < last)
      .filter(t => !grid.some(g => Math.abs(g - t) < tooClose))

    const sampleTimes = [...grid, ...extra]
      .sort((a, b) => a - b)
      .slice(0, MAX_PROBE_FRAMES + extra.length)

    console.log(
      `[monitor/probe] ${span.toFixed(1)}s clip → ${grid.length} grid frames ~${step.toFixed(2)}s apart` +
      (extra.length ? ` + ${extra.length} on spoken lines` : ''),
    )

    const frames: string[] = []
    const frameTimes: number[] = []
    for (let i = 0; i < sampleTimes.length; i++) {
      const outPath = join(tmpdir(), `mon_probe_${id}_${i}.jpg`)
      framePaths.push(outPath)
      const at = sampleTimes[i]
      const frame = await extractFrameAt(videoPath, at, outPath)
      // Kept in lockstep: a dropped frame must not shift every later timestamp.
      if (frame) {
        frames.push(frame)
        frameTimes.push(at)
      }
    }

    if (!frames.length) {
      console.warn('[monitor/probe] no frames extracted from', videoUrl.slice(0, 80))
      return null
    }

    // Both endpoints are re-hosted so Seedream can fetch them. Best-effort: a
    // failed upload only costs the corresponding keyframe, not the whole probe.
    const uploadFrame = async (b64: string, name: string): Promise<string | null> => {
      try {
        return await uploadBuffer(Buffer.from(b64, 'base64'), `monitor/${id}/${name}.jpg`, 'image/jpeg')
      } catch (err) {
        console.warn(`[monitor/probe] ${name} upload failed:`, err instanceof Error ? err.message : err)
        return null
      }
    }
    const firstFrameUrl = await uploadFrame(frames[0], 'first-frame')
    const lastFrameUrl = frames.length > 1
      ? await uploadFrame(frames[frames.length - 1], 'last-frame')
      : null

    return {
      frames,
      frameTimes,
      duration,
      cutCount: cutTimes.length,
      cutTimes,
      hasAudio,
      width,
      height,
      aspectRatio: bucketAspectRatio(width, height),
      firstFrameUrl,
      lastFrameUrl,
    }
  } catch (err) {
    console.warn('[monitor/probe] failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    for (const p of [videoPath, ...framePaths]) {
      try { if (existsSync(p)) unlinkSync(p) } catch {}
    }
  }
}
