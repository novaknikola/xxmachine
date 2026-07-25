import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const execFileAsync = promisify(execFile)

export interface VideoEffectOpts {
  brightness: boolean
  contrast: boolean
  saturation: boolean
  hue: boolean
  speed: boolean
  flipH: boolean
  crop: boolean
  fade: boolean
}

export interface VideoSettings {
  brightness: number
  contrast: number
  saturation: number
  hue: number
  flipH: boolean
  cropPct: number
  speed: number
  fade: boolean
}

function seededRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s ^= s >>> 16
    return (s >>> 0) / 0xffffffff
  }
}

function lerp(rng: () => number, min: number, max: number) {
  return min + rng() * (max - min)
}

export function randomVideoSettings(seed: number, opts: VideoEffectOpts): VideoSettings {
  const rng = seededRandom(seed)
  return {
    brightness: opts.brightness ? lerp(rng, -0.07, 0.07) : 0,
    contrast:   opts.contrast   ? lerp(rng, 0.88, 1.12)  : 1,
    saturation: opts.saturation ? lerp(rng, 0.82, 1.25)  : 1,
    hue:        opts.hue        ? lerp(rng, -10, 10)      : 0,
    flipH:      opts.flipH      && rng() > 0.5,
    cropPct:    opts.crop       ? lerp(rng, 0.01, 0.07)   : 0,
    speed:      opts.speed      ? lerp(rng, 0.97, 1.03)   : 1.0,
    fade:       opts.fade,
  }
}

export function buildVideoFilter(s: VideoSettings, fadeDuration?: number): string {
  const parts: string[] = []

  if (s.cropPct > 0) {
    const c = s.cropPct.toFixed(4)
    const h = (s.cropPct / 2).toFixed(4)
    parts.push(`crop=iw*(1-${c}):ih*(1-${c}):iw*${h}:ih*${h},scale=trunc(iw/2)*2:trunc(ih/2)*2`)
  } else {
    parts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }

  if (s.flipH) parts.push('hflip')

  const eq: string[] = []
  if (s.brightness !== 0) eq.push(`brightness=${s.brightness.toFixed(4)}`)
  if (s.contrast !== 1)   eq.push(`contrast=${s.contrast.toFixed(4)}`)
  if (s.saturation !== 1) eq.push(`saturation=${s.saturation.toFixed(4)}`)
  if (eq.length) parts.push(`eq=${eq.join(':')}`)

  if (s.hue !== 0) parts.push(`hue=h=${s.hue.toFixed(2)}`)

  if (Math.abs(s.speed - 1.0) > 0.001) {
    parts.push(`setpts=${(1 / s.speed).toFixed(4)}*PTS`)
  }

  // Force exact 1080x1920 (9:16) output
  parts.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')

  if (s.fade) {
    parts.push('fade=t=in:st=0:d=0.4')
    if (fadeDuration && fadeDuration > 1.0) {
      const outStart = Math.max(0, fadeDuration - 0.4)
      parts.push(`fade=t=out:st=${outStart.toFixed(2)}:d=0.4`)
    }
  }

  return parts.join(',')
}

export function buildAudioFilter(s: VideoSettings): string | null {
  if (Math.abs(s.speed - 1.0) > 0.001) {
    return `atempo=${s.speed.toFixed(4)}`
  }
  return null
}

export async function getVideoDuration(inputPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', inputPath,
    ])
    const json = JSON.parse(stdout)
    const d = parseFloat(json.format?.duration ?? '0')
    return d > 0 ? d : null
  } catch {
    return null
  }
}

export interface VideoDimensions {
  width: number
  height: number
}

/** Real display dimensions of the video's first stream, swapped for ±90° rotation metadata. */
export async function getVideoDimensions(inputPath: string): Promise<VideoDimensions | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath,
    ])
    const json = JSON.parse(stdout)
    const stream = (json.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video')
    if (!stream) return null

    let width = Number(stream.width)
    let height = Number(stream.height)
    if (!width || !height) return null

    const rotateTag = Number(stream.tags?.rotate ?? 0)
    const sideDataRotation = Number(
      (stream.side_data_list ?? []).find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0,
    )
    const rotation = ((rotateTag || sideDataRotation) % 360 + 360) % 360
    if (rotation === 90 || rotation === 270) {
      [width, height] = [height, width]
    }

    return { width, height }
  } catch {
    return null
  }
}

export async function processVideoVariant(
  inputPath: string,
  seed: number,
  opts: VideoEffectOpts,
  fadeDuration?: number,
): Promise<string | null> {
  const settings = randomVideoSettings(seed, opts)
  const vf = buildVideoFilter(settings, fadeDuration)
  const af = buildAudioFilter(settings)
  const outputPath = join(tmpdir(), `vr_${randomUUID()}.mp4`)

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', vf,
      ...(af ? ['-af', af] : []),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      ...(af ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'copy']),
      '-map_metadata', '-1', '-movflags', '+faststart',
      outputPath,
    ])
    if (existsSync(outputPath)) return outputPath
    return null
  } catch (err) {
    console.error('[video-ffmpeg] variant failed:', err instanceof Error ? err.message : err)
    try { if (existsSync(outputPath)) unlinkSync(outputPath) } catch {}
    return null
  }
}
