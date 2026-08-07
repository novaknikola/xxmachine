import type { SourceAspectRatio } from './analyze'

/**
 * bytedance/seedance-2.0/video-edit via WaveSpeed — restyles the original
 * source clip directly, using our Seedream Edit keyframe(s) as character/
 * style reference. Replaces the old image-to-video approach (synthetic
 * animation from a single start/end keyframe pair).
 */
export const SEEDANCE_MODEL = 'bytedance/seedance-2.0/video-edit'

export interface SeedanceCallInput {
  /** The original scraped source video — supplies motion, timing, and pacing. */
  videoUrl: string
  /** Seedream Edit keyframe(s) — identity composited onto the source frame(s) — guide character appearance. */
  referenceImageUrls: string[]
  /** renderCopyPastePrompt(spec) output. */
  prompt: string
  aspectRatio: SourceAspectRatio
}

export function buildSeedancePayload(input: SeedanceCallInput): Record<string, unknown> {
  return {
    video: input.videoUrl,
    reference_images: input.referenceImageUrls,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio === 'other' ? '9:16' : input.aspectRatio,
    resolution: '720p',
    generate_audio: true,
    enable_web_search: false,
  }
}
