import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { writeFileSync, existsSync, unlinkSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  processVideoVariant,
  getVideoDuration,
  type VideoEffectOpts,
} from '@/lib/video-ffmpeg'

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

// POST — process video immediately (max 10 variants, blocking)
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  cleanup()
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const count = Math.min(Number(form.get('count') ?? 3), 10)
    const baseSeed = Number(form.get('seed') ?? Math.floor(Math.random() * 0xffffff))

    const opts: VideoEffectOpts = {
      brightness: form.get('brightness') !== 'false',
      contrast:   form.get('contrast')   !== 'false',
      saturation: form.get('saturation') !== 'false',
      hue:        form.get('hue')        === 'true',
      speed:      form.get('speed')      === 'true',
      flipH:      form.get('flipH')      === 'true',
      crop:       form.get('crop')       !== 'false',
      fade:       form.get('fade')       === 'true',
    }

    const inputPath = join(tmpdir(), `vr_in_${randomUUID()}.mp4`)
    writeFileSync(inputPath, Buffer.from(await file.arrayBuffer()))

    const fadeDuration = opts.fade ? (await getVideoDuration(inputPath) ?? undefined) : undefined
    const results: Array<{ id: string; seed: number }> = []

    for (let i = 0; i < count; i++) {
      const seed = baseSeed + i * 1337
      const outputPath = await processVideoVariant(inputPath, seed, opts, fadeDuration)

      if (outputPath) {
        const id = randomUUID()
        const stablePath = join(tmpdir(), `vr_${id}.mp4`)
        try {
          renameSync(outputPath, stablePath)
          videoStore.set(id, { path: stablePath, expires: Date.now() + 3_600_000 })
          results.push({ id, seed })
        } catch {
          try { unlinkSync(outputPath) } catch {}
        }
      }
    }

    try { unlinkSync(inputPath) } catch {}
    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

// GET — stream a processed video by ID
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

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
