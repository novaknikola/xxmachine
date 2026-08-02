import type { SourceAspectRatio } from './analyze'

/** bytedance/seedance-2.0/image-to-video via WaveSpeed. */
export const SEEDANCE_MODEL = 'bytedance/seedance-2.0/image-to-video'

export interface SeedanceCallInput {
  /** The Seedream Edit keyframe (identity composited onto the source frame) — becomes Seedance's `image` (start frame). */
  imageUrl: string
  /**
   * Optional matching end keyframe → Seedance's `last_image`. Must itself be a
   * Seedream Edit output; a raw source frame here would pull the original
   * person's face back into the clip.
   */
  lastImageUrl?: string | null
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
  const payload: Record<string, unknown> = {
    image: input.imageUrl,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio === 'other' ? '9:16' : input.aspectRatio,
    resolution: '720p',
    duration: seedanceDuration(input.durationSec),
    generate_audio: true,
    enable_web_search: false,
  }
  if (input.lastImageUrl) payload.last_image = input.lastImageUrl
  return payload
}
