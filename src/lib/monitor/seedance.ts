import type { SourceAspectRatio } from './analyze'

/** bytedance/seedance-2.0/image-to-video via WaveSpeed. */
export const SEEDANCE_MODEL = 'bytedance/seedance-2.0/image-to-video'

export interface SeedanceCallInput {
  /** User's uploaded photo, unmodified — becomes Seedance's `image` (identity + start frame). */
  referenceImageUrl: string
  /** renderCopyPastePrompt(spec) output. */
  prompt: string
  durationSec: number | null
  aspectRatio: SourceAspectRatio
}

function seedanceDuration(durationSec: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return Math.min(15, Math.max(4, Math.round(durationSec)))
}

export function buildSeedancePayload(input: SeedanceCallInput): Record<string, unknown> {
  return {
    image: input.referenceImageUrl,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio === 'other' ? '9:16' : input.aspectRatio,
    resolution: '720p',
    duration: seedanceDuration(input.durationSec),
    generate_audio: true,
    enable_web_search: false,
  }
}
