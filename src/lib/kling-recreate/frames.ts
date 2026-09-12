import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { isPlayableVideoUrl } from '@/lib/monitor/video-url'
import { uploadBuffer } from '@/lib/supabase-storage'
import type { SourceAspectRatio } from '@/lib/monitor/analyze'
import { MAX_FPS_FRAMES } from './types'

const execFileAsync = promisify(execFile)
const FF_TIMEOUT_MS = 45_000
const MAX_VIDEO_BYTES = 40_000_000
const FRAME_WIDTH = 720

function ff(cmd: string, args: string[], opts?: { timeout?: number; maxBuffer?: number }) {
  return execFileAsync(cmd, args, {
    maxBuffer: opts?.maxBuffer,
    timeout: opts?.timeout ?? FF_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
}

export interface OneFpsExtract {
  frames: Array<{ t_sec: number; image_url: string; base64: string }>
  duration: number | null
  width: number | null
  height: number | null
  hasAudio: boolean
  aspectRatio: SourceAspectRatio
}

function bucketAspectRatio(width: number | null, height: number | null): SourceAspectRatio {
  if (!width || !height) return 'other'
  const ratio = width / height
  const candidates: Array<{ label: SourceAspectRatio; value: number }> = [
    { label: '9:16', value: 9 / 16 },
    { label: '16:9', value: 16 / 9 },
    { label: '1:1', value: 1 },
  ]
  let best: { label: SourceAspectRatio; diff: number } | null = null
  for (const c of candidates) {
    const diff = Math.abs(ratio - c.value)
    if (diff <= 0.08 && (!best || diff < best.diff)) best = { label: c.label, diff }
  }
  return best?.label ?? 'other'
}

async function downloadVideo(videoUrl: string, path: string): Promise<void> {
  if (!isPlayableVideoUrl(videoUrl)) {
    throw new Error(`not a direct video URL: ${videoUrl.slice(0, 80)}`)
  }
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(45_000) })
  if (!res.ok) throw new Error(`source video fetch failed: ${res.status}`)
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html')) throw new Error('source URL returned HTML, not video')
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_VIDEO_BYTES) throw new Error(`source video too large: ${declared} bytes`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength < 8_000) throw new Error('source download too small to be a video')
  if (buffer.byteLength > MAX_VIDEO_BYTES) throw new Error('source video too large')
  writeFileSync(path, buffer)
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
    const streams = (json.streams ?? []) as Array<{ codec_type?: string; width?: number; height?: number }>
    const videoStream = streams.find(s => s.codec_type === 'video')
    return {
      duration: duration > 0 ? duration : null,
      hasAudio: streams.some(s => s.codec_type === 'audio'),
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
    }
  } catch {
    return { duration: null, hasAudio: false, width: null, height: null }
  }
}

/**
 * One JPEG per whole second (t = 0, 1, 2, …), uploaded and also kept as
 * base64 for the vision call. Caps at MAX_FPS_FRAMES so a long source cannot
 * spawn unbounded Grok calls.
 */
export async function extractOneFpsFrames(
  videoUrl: string,
  storagePrefix: string,
): Promise<OneFpsExtract> {
  const id = randomUUID()
  const videoPath = join(tmpdir(), `kling_fps_${id}.mp4`)
  const framePaths: string[] = []

  try {
    await downloadVideo(videoUrl, videoPath)
    const format = await probeFormat(videoPath)
    const duration = format.duration ?? 1
    const lastWhole = Math.max(0, Math.min(MAX_FPS_FRAMES - 1, Math.floor(duration)))
    const times: number[] = []
    for (let t = 0; t <= lastWhole; t++) times.push(t)
    if (times.length === 0) times.push(0)

    const frames: OneFpsExtract['frames'] = []
    for (const t of times) {
      const outPath = join(tmpdir(), `kling_fps_${id}_${t}.jpg`)
      framePaths.push(outPath)
      try {
        await ff('ffmpeg', [
          '-y', '-ss', t.toFixed(2), '-i', videoPath,
          '-vframes', '1', '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '3', outPath,
        ], { timeout: 20_000 })
      } catch {
        continue
      }
      if (!existsSync(outPath)) continue
      const buf = readFileSync(outPath)
      const imageUrl = await uploadBuffer(buf, `${storagePrefix}/t${t}.jpg`, 'image/jpeg')
      frames.push({ t_sec: t, image_url: imageUrl, base64: buf.toString('base64') })
    }

    if (!frames.length) throw new Error('ffmpeg extracted no frames')

    return {
      frames,
      duration: format.duration,
      width: format.width,
      height: format.height,
      hasAudio: format.hasAudio,
      aspectRatio: bucketAspectRatio(format.width, format.height),
    }
  } finally {
    try { unlinkSync(videoPath) } catch { /* tmp */ }
    for (const p of framePaths) {
      try { unlinkSync(p) } catch { /* tmp */ }
    }
  }
}
