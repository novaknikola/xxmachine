/**
 * Kept free of node imports (unlike video-ffmpeg.ts) so client components can
 * import it directly — same constraint reproduce-logic.ts already satisfies
 * on the image side.
 */

export interface VideoEffectRange {
  min: number
  max: number
}

export interface VideoEffectRanges {
  brightness: VideoEffectRange
  contrast: VideoEffectRange
  saturation: VideoEffectRange
  hue: VideoEffectRange
  speed: VideoEffectRange
  crop: VideoEffectRange
}

/**
 * The numbers video-ffmpeg.ts always used before ranges became configurable.
 * Every caller that never sends a ranges object — Telegram repurpose,
 * Copy-Paste's automatic profiles, any job queued before this existed —
 * keeps producing exactly the same output through this default.
 */
export const DEFAULT_VIDEO_RANGES: VideoEffectRanges = {
  brightness: { min: -0.07, max: 0.07 },
  contrast: { min: 0.88, max: 1.12 },
  saturation: { min: 0.82, max: 1.25 },
  hue: { min: -10, max: 10 },
  speed: { min: 0.97, max: 1.03 },
  crop: { min: 0.01, max: 0.07 },
}
