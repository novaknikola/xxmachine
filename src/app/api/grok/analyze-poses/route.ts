import { NextRequest, NextResponse } from 'next/server'
import { generateVariantPrompts, generateCarouselVariantPrompts, type CarouselPromptStyle } from '@/lib/pose-variants'
import { requireUser } from '@/lib/session'
import {
  CAROUSEL_GROK_HINT_CATCHY,
  CAROUSEL_GROK_HINT_CLASSIC,
  CAROUSEL_GROK_HINT_OUTFIT,
} from '@/lib/carousel-presets'

function defaultCarouselHint(style: CarouselPromptStyle): string {
  if (style === 'outfit') return CAROUSEL_GROK_HINT_OUTFIT
  if (style === 'catchy') return CAROUSEL_GROK_HINT_CATCHY
  return CAROUSEL_GROK_HINT_CLASSIC
}

function parseCarouselStyle(raw: string | null): CarouselPromptStyle {
  if (raw === 'classic' || raw === 'outfit' || raw === 'catchy') return raw
  return 'catchy'
}

export async function POST(req: NextRequest) {
  try {
    // This route is excluded from the proxy matcher (multipart uploads), so it is the only auth gate.
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const form = await req.formData()

    const files = form.getAll('files[]') as File[]
    const singleFile = form.get('file') as File | null
    const allFiles = files.length > 0 ? files : singleFile ? [singleFile] : []
    const mode = (form.get('mode') as string | null)?.trim() ?? 'wan'
    const style = parseCarouselStyle((form.get('style') as string | null)?.trim() ?? null)
    const hint = (form.get('hint') as string | null)?.trim()
      ?? (mode === 'carousel' ? defaultCarouselHint(style) : '')
    const count = Number(form.get('count') ?? 5)

    if (!allFiles.length) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 })
    }

    const imageBuffers = await Promise.all(
      allFiles.map(async f => ({ buffer: Buffer.from(await f.arrayBuffer()), mime: f.type || 'image/jpeg' }))
    )

    const prompts = mode === 'carousel'
      ? await generateCarouselVariantPrompts(imageBuffers, count, hint, style)
      : await generateVariantPrompts(imageBuffers, count, hint)

    if (!prompts.length) {
      return NextResponse.json({ error: 'Failed to generate prompts' }, { status: 502 })
    }

    // Pad to requested count if needed
    while (prompts.length < count) prompts.push('')

    return NextResponse.json({ prompts: prompts.slice(0, count) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
