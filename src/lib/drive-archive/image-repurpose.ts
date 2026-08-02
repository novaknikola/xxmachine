import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'
import type { ContentFormat } from './content-format'
import {
  profileForFormat,
  type ImageRepurposeProfile,
  type RepurposeStrength,
} from './repurpose-profiles'

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

/**
 * Largest centred, aspect-preserving crop that contains no black corner after
 * rotating by `deg`. Below this the rotation's fill leaks into the output.
 */
function maxKeepForRotation(deg: number, width: number, height: number): number {
  const t = Math.abs((deg * Math.PI) / 180)
  if (t < 1e-4) return 1
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height))
  return 1 / (Math.cos(t) + ratio * Math.sin(t))
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
  const rotate = profile.rotateDeg ? lerp(rng, profile.rotateDeg.min, profile.rotateDeg.max) : 0

  // The crop must both honour the profile and stay inside the rotated frame.
  const rotationLimit = maxKeepForRotation(rotate, width, height)
  const keep = Math.max(0.55, Math.min(0.99, rotationLimit, (1 - cropPct) / zoom))

  // centerBias 1 lets the window sit anywhere; lower values pull it toward the
  // middle so a large crop cannot behead the subject.
  const bias = Math.max(0, Math.min(1, profile.centerBias ?? 1))
  const avail = 1 - keep
  const offset = (r: number) => (avail > 0 ? avail / 2 + (r - 0.5) * avail * bias : 0)
  const xFrac = offset(rng())
  const yFrac = offset(rng())

  const br = lerp(rng, profile.brightness.min, profile.brightness.max)
  const co = lerp(rng, profile.contrast.min, profile.contrast.max)
  const sa = lerp(rng, profile.saturation.min, profile.saturation.max)
  const hu = lerp(rng, profile.hue.min, profile.hue.max)
  const grain = Math.round(lerp(rng, profile.grain.min, profile.grain.max))
  const vig = lerp(rng, profile.vignette.min, profile.vignette.max)
  const flip = rng() < profile.flipHChance
  const cb = profile.colorBalance ? lerp(rng, profile.colorBalance.min, profile.colorBalance.max) : 0
  const curves = profile.curvesPresets?.length
    ? profile.curvesPresets[Math.floor(rng() * profile.curvesPresets.length)] ?? ''
    : ''

  const parts: string[] = []
  // Rotate first so the crop below trims the black corners it leaves behind.
  if (Math.abs(rotate) > 0.01) {
    parts.push(`rotate=${((rotate * Math.PI) / 180).toFixed(5)}:ow=iw:oh=ih`)
  }
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
  // Warm/cool push in the midtones — reads as a different camera or grade.
  if (Math.abs(cb) > 0.005) {
    parts.push(`colorbalance=rm=${cb.toFixed(3)}:bm=${(-cb).toFixed(3)}`)
  }
  if (curves) parts.push(`curves=preset=${curves}`)
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
 * Render one variant from an already-downloaded, already-probed source.
 * Kept separate from the download so N variants reuse a single fetch.
 */
async function renderVariant(
  inPath: string,
  size: { w: number; h: number },
  profile: ImageRepurposeProfile,
  seed: number,
): Promise<Buffer> {
  const outPath = join(tmpdir(), `rp_out_${randomUUID()}.jpg`)
  try {
    const vf = buildFilter(profile, seed, size.w, size.h)
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
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
  }
}

/**
 * Download a source once, hand the local path + dimensions to `fn`, then clean up.
 * Every variant of one image shares this fetch and probe.
 */
async function withSource<T>(
  sourceUrl: string,
  fn: (inPath: string, size: { w: number; h: number }) => Promise<T>,
): Promise<T> {
  const inPath = await downloadToTemp(sourceUrl)
  try {
    return await fn(inPath, await probeSize(inPath))
  } finally {
    try { if (existsSync(inPath)) unlinkSync(inPath) } catch { /* ignore */ }
  }
}

/**
 * Apply a format-specific uniqueness pass via ffmpeg and return JPEG bytes.
 */
export async function repurposeImageBuffer(
  sourceUrl: string,
  format: ContentFormat,
  seed: number,
  strength: RepurposeStrength = 'dedupe',
): Promise<Buffer> {
  const profile = profileForFormat(format, strength)
  return withSource(sourceUrl, (inPath, size) => renderVariant(inPath, size, profile, seed))
}

/**
 * Repurpose one image and upload to Storage. Returns the public URL.
 */
export async function repurposeAndUploadImage(opts: {
  sourceUrl: string
  format: ContentFormat
  storagePath: string
  seed?: number
  strength?: RepurposeStrength
}): Promise<string> {
  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  const buf = await repurposeImageBuffer(opts.sourceUrl, opts.format, seed, opts.strength)
  return uploadBuffer(buf, opts.storagePath, 'image/jpeg')
}

/**
 * Repurpose each URL with retries. Failed slots are skipped (never returned as originals).
 *
 * `variants` controls how many distinct ready/ files come out of each source. The
 * source is fetched and probed once per image no matter how many variants are asked
 * for — only the ffmpeg pass repeats.
 */
export async function repurposeImageUrls(opts: {
  urls: string[]
  format: ContentFormat
  basePath: string
  /** Attempts per variant (default 3). */
  maxAttempts?: number
  /** Ready files per source image. Defaults to the format profile's `count`. */
  variants?: number
  /** dedupe = invisible re-upload guard, distinct = visibly different assets. */
  strength?: RepurposeStrength
}): Promise<{ readyUrls: string[]; skipped: number }> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const profile = profileForFormat(opts.format, opts.strength ?? 'dedupe')
  const variants = Math.max(1, Math.floor(opts.variants ?? profile.count ?? 1))
  const readyUrls: string[] = []
  let skipped = 0

  for (let i = 0; i < opts.urls.length; i++) {
    const src = opts.urls[i]!
    try {
      await withSource(src, async (inPath, size) => {
        for (let v = 0; v < variants; v++) {
          // Keep the historical name for a single variant so existing ready/ files
          // stay addressable; only fan out the suffix when more than one is asked for.
          const suffix = variants > 1 ? `_v${v + 1}` : ''
          const storagePath = `${opts.basePath}/ready_${i + 1}${suffix}.jpg`
          let done = false
          let lastErr: unknown

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const seed =
                (Date.now() ^ (i * 2654435761) ^ (v * 40503) ^ (attempt * 97)) >>> 0
              const buf = await renderVariant(inPath, size, profile, seed)
              readyUrls.push(await uploadBuffer(buf, storagePath, 'image/jpeg'))
              done = true
              break
            } catch (err) {
              lastErr = err
              console.warn(
                `[image-repurpose] slot ${i} variant ${v + 1} attempt ${attempt}/${maxAttempts} failed:`,
                err instanceof Error ? err.message : err,
              )
            }
          }

          if (!done) {
            skipped++
            console.error(
              `[image-repurpose] slot ${i} variant ${v + 1} skipped after ${maxAttempts} attempts — not placing original in ready/:`,
              lastErr,
            )
          }
        }
      })
    } catch (err) {
      // Download or probe failed — the whole image is unusable, so every variant is lost.
      skipped += variants
      console.error(
        `[image-repurpose] slot ${i} source unavailable — skipped all ${variants} variant(s):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { readyUrls, skipped }
}
