import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'
import type { ContentFormat } from './content-format'
import { profileForFormat, type ImageRepurposeProfile } from './repurpose-profiles'

const execFileAsync = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

function seededRng(seed: number) {
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

async function probeSize(path: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', path,
  ], { timeout: 20_000 })
  const json = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>
  }
  const stream = (json.streams ?? []).find(s => s.codec_type === 'video' || s.width)
  const w = Number(stream?.width)
  const h = Number(stream?.height)
  if (!w || !h) throw new Error('Could not probe image size')
  return { w, h }
}

function buildFilter(
  profile: ImageRepurposeProfile,
  seed: number,
  width: number,
  height: number,
): string {
  const rng = seededRng(seed)
  const cropPct = lerp(rng, profile.cropPct.min, profile.cropPct.max)
  const zoom = lerp(rng, profile.zoom.min, profile.zoom.max)
  const keep = Math.max(0.7, Math.min(0.99, (1 - cropPct) / zoom))
  const availX = 1 - keep
  const availY = 1 - keep
  const xFrac = availX > 0 ? rng() * availX : 0
  const yFrac = availY > 0 ? rng() * availY : 0

  const br = lerp(rng, profile.brightness.min, profile.brightness.max)
  const co = lerp(rng, profile.contrast.min, profile.contrast.max)
  const sa = lerp(rng, profile.saturation.min, profile.saturation.max)
  const hu = lerp(rng, profile.hue.min, profile.hue.max)
  const grain = Math.round(lerp(rng, profile.grain.min, profile.grain.max))
  const vig = lerp(rng, profile.vignette.min, profile.vignette.max)
  const flip = rng() < profile.flipHChance

  const parts: string[] = []
  parts.push(
    `crop=iw*${keep.toFixed(4)}:ih*${keep.toFixed(4)}:iw*${xFrac.toFixed(4)}:ih*${yFrac.toFixed(4)}`,
  )
  parts.push(`scale=${width}:${height}`)
  if (flip) parts.push('hflip')

  const eq: string[] = []
  if (Math.abs(br) > 0.001) eq.push(`brightness=${br.toFixed(4)}`)
  if (Math.abs(co - 1) > 0.001) eq.push(`contrast=${co.toFixed(4)}`)
  if (Math.abs(sa - 1) > 0.001) eq.push(`saturation=${sa.toFixed(4)}`)
  if (eq.length) parts.push(`eq=${eq.join(':')}`)
  if (Math.abs(hu) > 0.1) parts.push(`hue=h=${hu.toFixed(2)}`)
  if (grain > 0) parts.push(`noise=alls=${grain}:allf=t+u`)
  if (vig > 0.01) {
    // vignette angle: larger = stronger darkening at edges
    const angle = (Math.PI / 5 + vig * (Math.PI / 3)).toFixed(4)
    parts.push(`vignette=angle=${angle}`)
  }

  return parts.join(',')
}

async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength < 500) throw new Error('download too small')
  const ext = url.toLowerCase().includes('.png') ? 'png' : 'jpg'
  const path = join(tmpdir(), `rp_in_${randomUUID()}.${ext}`)
  writeFileSync(path, buf)
  return path
}

/**
 * Apply a format-specific uniqueness pass via ffmpeg and return JPEG bytes.
 */
export async function repurposeImageBuffer(
  sourceUrl: string,
  format: ContentFormat,
  seed: number,
): Promise<Buffer> {
  const profile = profileForFormat(format)
  const inPath = await downloadToTemp(sourceUrl)
  const outPath = join(tmpdir(), `rp_out_${randomUUID()}.jpg`)
  try {
    const { w, h } = await probeSize(inPath)
    const vf = buildFilter(profile, seed, w, h)
    await execFileAsync(FFMPEG, [
      '-y', '-i', inPath,
      '-vf', vf,
      '-q:v', '2',
      '-map_metadata', '-1',
      outPath,
    ], { timeout: 60_000, maxBuffer: 20_000_000 })
    if (!existsSync(outPath)) throw new Error('ffmpeg produced no output')
    return readFileSync(outPath)
  } finally {
    try { if (existsSync(inPath)) unlinkSync(inPath) } catch { /* ignore */ }
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
  }
}

/**
 * Repurpose one image and upload to Storage. Returns the public URL.
 */
export async function repurposeAndUploadImage(opts: {
  sourceUrl: string
  format: ContentFormat
  storagePath: string
  seed?: number
}): Promise<string> {
  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  const buf = await repurposeImageBuffer(opts.sourceUrl, opts.format, seed)
  return uploadBuffer(buf, opts.storagePath, 'image/jpeg')
}

/**
 * Repurpose each URL with retries. Failed slots are skipped (never returned as originals).
 */
export async function repurposeImageUrls(opts: {
  urls: string[]
  format: ContentFormat
  basePath: string
  /** Attempts per image (default 3). */
  maxAttempts?: number
}): Promise<{ readyUrls: string[]; skipped: number }> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const readyUrls: string[] = []
  let skipped = 0

  for (let i = 0; i < opts.urls.length; i++) {
    const src = opts.urls[i]!
    let done = false
    let lastErr: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = await repurposeAndUploadImage({
          sourceUrl: src,
          format: opts.format,
          storagePath: `${opts.basePath}/ready_${i + 1}.jpg`,
          seed: (Date.now() ^ (i * 2654435761) ^ (attempt * 97)) >>> 0,
        })
        readyUrls.push(url)
        done = true
        break
      } catch (err) {
        lastErr = err
        console.warn(
          `[image-repurpose] slot ${i} attempt ${attempt}/${maxAttempts} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    if (!done) {
      skipped++
      console.error(
        `[image-repurpose] slot ${i} skipped after ${maxAttempts} attempts — not placing original in ready/:`,
        lastErr,
      )
    }
  }

  return { readyUrls, skipped }
}
