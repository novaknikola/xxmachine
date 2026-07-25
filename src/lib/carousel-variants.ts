import {
  getCarouselVariantPrompts,
  getCarouselGrokHint,
  getCarouselGrokStyle,
  DEFAULT_CAROUSEL_PRESET_ID,
} from './carousel-presets'
import { generateCarouselVariantPrompts } from './pose-variants'

export interface CarouselVariantOptions {
  presetId?: string
  count: number
  scenePrompt: string
  grokSmart?: boolean
  baseImageUrl?: string
}

/** Resolve carousel edit prompts — preset pool or Grok vision on the base image. */
export async function resolveCarouselVariantPrompts(opts: CarouselVariantOptions): Promise<string[]> {
  const presetId = opts.presetId ?? DEFAULT_CAROUSEL_PRESET_ID
  const count = Math.max(1, Math.min(4, opts.count))

  if (opts.grokSmart && opts.baseImageUrl) {
    try {
      const res = await fetch(opts.baseImageUrl)
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
        const grokStyle = getCarouselGrokStyle(presetId)
        const grokPrompts = await generateCarouselVariantPrompts(
          [{ buffer, mime }],
          count,
          getCarouselGrokHint(presetId),
          grokStyle,
        )
        const cleaned = grokPrompts.map(p => p.trim()).filter(Boolean)
        if (cleaned.length >= count) return cleaned.slice(0, count)
        if (cleaned.length) return cleaned
      }
    } catch (err) {
      console.error('[carousel-variants] Grok smart failed, falling back to preset:', err)
    }
  }

  return getCarouselVariantPrompts(presetId, count, opts.scenePrompt)
}
