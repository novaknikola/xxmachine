import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const execFileAsync = promisify(execFile)
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'

// In-memory store: id → file path (cleaned up after 1 hour)
const videoStore = new Map<string, { path: string; expires: number }>()

function cleanup() {
  const now = Date.now()
  for (const [id, entry] of videoStore.entries()) {
    if (now > entry.expires) {
      try { if (existsSync(entry.path)) unlinkSync(entry.path) } catch {}
      videoStore.delete(id)
    }
  }
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

function randomSettings(seed: number, opts: Record<string, boolean>) {
  const rng = seededRandom(seed)
  return {
    brightness: opts.brightness ? lerp(rng, -0.07, 0.07) : 0,
    contrast:   opts.contrast   ? lerp(rng, 0.88, 1.12)  : 1,
    saturation: opts.saturation ? lerp(rng, 0.82, 1.25)  : 1,
    hue:        opts.hue        ? lerp(rng, -10, 10)      : 0,
    flipH:      opts.flipH && rng() > 0.5,
    cropPct:    opts.crop       ? lerp(rng, 0.01, 0.07)   : 0,
  }
}

function buildVf(s: ReturnType<typeof randomSettings>): string {
  const parts: string[] = []

  if (s.cropPct > 0) {
    const c = s.cropPct.toFixed(4)
    const h = (s.cropPct / 2).toFixed(4)
    // scale back and force even dimensions (libx264 requirement)
    parts.push(`crop=iw*(1-${c}):ih*(1-${c}):iw*${h}:ih*${h},scale=trunc(iw/2)*2:trunc(ih/2)*2`)
  } else {
    // Always ensure even dimensions
    parts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }

  if (s.flipH) parts.push('hflip')

  const eq: string[] = []
  if (s.brightness !== 0) eq.push(`brightness=${s.brightness.toFixed(4)}`)
  if (s.contrast !== 1)   eq.push(`contrast=${s.contrast.toFixed(4)}`)
  if (s.saturation !== 1) eq.push(`saturation=${s.saturation.toFixed(4)}`)
  if (eq.length) parts.push(`eq=${eq.join(':')}`)

  if (s.hue !== 0) parts.push(`hue=h=${s.hue.toFixed(2)}`)

  // Force exact 1080x1920 (9:16) output — scale up to fill, then center-crop
  // Ensures no black bars and standard Instagram/TikTok resolution regardless of effects
  parts.push('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920')

  return parts.join(',')
}

// POST — process video and return IDs
export async function POST(req: NextRequest) {
  cleanup()
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const count = Math.min(Number(form.get('count') ?? 3), 10)
    const baseSeed = Math.floor(Math.random() * 0xffffff)
    const opts = {
      brightness: form.get('brightness') !== 'false',
      contrast:   form.get('contrast')   !== 'false',
      saturation: form.get('saturation') !== 'false',
      hue:        form.get('hue')        === 'true',
      flipH:      form.get('flipH')      === 'true',
      crop:       form.get('crop')       !== 'false',
    }

    const inputPath = join(tmpdir(), `vr_in_${randomUUID()}.mp4`)
    writeFileSync(inputPath, Buffer.from(await file.arrayBuffer()))

    const results: Array<{ id: string; seed: number }> = []
    const failures: string[] = []

    for (let i = 0; i < count; i++) {
      const seed = baseSeed + i * 1337
      const settings = randomSettings(seed, opts)
      const id = randomUUID()
      const outputPath = join(tmpdir(), `vr_${id}.mp4`)

      try {
        const vf = buildVf(settings)
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-i', inputPath,
          '-vf', vf,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-an', '-map_metadata', '-1', '-movflags', '+faststart',
          outputPath,
        ])

        if (existsSync(outputPath)) {
          videoStore.set(id, { path: outputPath, expires: Date.now() + 3_600_000 })
          results.push({ id, seed })
        }
      } catch (err) {
        console.error(`[video-reproduce] variant ${i} failed:`, err instanceof Error ? err.message : err)
      }
    }

    try { unlinkSync(inputPath) } catch {}

    if (results.length === 0) {
      return NextResponse.json({
        error: failures[0] || 'No video variants generated. Please verify FFmpeg is installed and the uploaded file is a valid video.',
        failures,
      }, { status: 500 })
    }

    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

// GET — stream a processed video by ID
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const entry = videoStore.get(id)
  if (!entry || !existsSync(entry.path)) {
    return NextResponse.json({ error: 'Video not found or expired' }, { status: 404 })
  }

  const { readFile } = await import('fs/promises')
  const buffer = await readFile(entry.path)

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(buffer.length),
      'Content-Disposition': `inline; filename="variation_${id.slice(0, 8)}.mp4"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

