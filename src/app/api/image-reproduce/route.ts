import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { randomUUID } from 'crypto'
import { processImageVariant } from '@/lib/image-sharp'
import type { ReproduceSettings } from '@/app/(dashboard)/repurpose/reproduce-logic'

// In-memory store: id → JPEG buffer (cleaned up after 1 hour)
const imageStore = new Map<string, { buffer: Buffer; expires: number }>()

function cleanup() {
  const now = Date.now()
  for (const [id, entry] of imageStore.entries()) {
    if (now > entry.expires) imageStore.delete(id)
  }
}

// POST — process image immediately (max 10 variants, blocking)
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  cleanup()
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const settingsRaw = form.get('settings')
    if (typeof settingsRaw !== 'string') {
      return NextResponse.json({ error: 'Missing settings' }, { status: 400 })
    }
    const settings = JSON.parse(settingsRaw) as ReproduceSettings

    const count = Math.min(Number(form.get('count') ?? settings.count ?? 3), 10)
    const baseSeed = Number(form.get('seed') ?? Math.floor(Math.random() * 0xffffff))

    const sourceBuffer = Buffer.from(await file.arrayBuffer())
    const results: Array<{ id: string; seed: number }> = []
    const failures: string[] = []

    for (let i = 0; i < count; i++) {
      const seed = baseSeed + i * 1337
      try {
        const buf = await processImageVariant(sourceBuffer, seed, settings)
        const id = randomUUID()
        imageStore.set(id, { buffer: buf, expires: Date.now() + 3_600_000 })
        results.push({ id, seed })
      } catch (err) {
        failures.push(`Variant ${i + 1}: ${err instanceof Error ? err.message : 'failed'}`)
      }
    }

    if (results.length === 0) {
      return NextResponse.json({
        error: failures[0] || 'No image variants generated.',
        failures,
      }, { status: 500 })
    }

    return NextResponse.json({ results })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

// GET — stream a processed image by ID
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const entry = imageStore.get(id)
  if (!entry) {
    return NextResponse.json({ error: 'Image not found or expired' }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(entry.buffer), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(entry.buffer.length),
      'Content-Disposition': `inline; filename="variation_${id.slice(0, 8)}.jpg"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
