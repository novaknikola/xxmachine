import type { ContentFormat } from './content-format'

export interface ImageRepurposeProfile {
  /** How many unique variants per source image (auto pipeline uses 1). */
  count: number
  cropPct: { min: number; max: number }
  /** Extra zoom after crop, 1 = none. */
  zoom: { min: number; max: number }
  brightness: { min: number; max: number } // ffmpeg eq units ≈ -0.2..0.2
  contrast: { min: number; max: number }   // 0.8..1.2
  saturation: { min: number; max: number }
  hue: { min: number; max: number }        // degrees
  grain: { min: number; max: number }      // ffmpeg noise alls
  vignette: { min: number; max: number }   // 0..1 strength
  flipHChance: number                      // 0..1
}

/**
 * Soft uniqueness profiles — strong enough for platform re-upload,
 * mild enough not to ruin faces / carousel cohesion.
 */
export const REPURPOSE_PROFILES: Record<ContentFormat, ImageRepurposeProfile> = {
  stories: {
    count: 1,
    cropPct: { min: 0.04, max: 0.12 },
    zoom: { min: 1.0, max: 1.08 },
    brightness: { min: -0.08, max: 0.08 },
    contrast: { min: 0.92, max: 1.12 },
    saturation: { min: 0.88, max: 1.18 },
    hue: { min: -6, max: 6 },
    grain: { min: 3, max: 12 },
    vignette: { min: 0.05, max: 0.28 },
    flipHChance: 0.45,
  },
  carousels: {
    count: 1,
    cropPct: { min: 0.01, max: 0.05 },
    zoom: { min: 1.0, max: 1.04 },
    brightness: { min: -0.05, max: 0.05 },
    contrast: { min: 0.95, max: 1.08 },
    saturation: { min: 0.92, max: 1.1 },
    hue: { min: -3, max: 3 },
    grain: { min: 1, max: 6 },
    vignette: { min: 0, max: 0.12 },
    flipHChance: 0.15,
  },
  reels: {
    count: 1,
    cropPct: { min: 0.02, max: 0.08 },
    zoom: { min: 1.0, max: 1.06 },
    brightness: { min: -0.07, max: 0.07 },
    contrast: { min: 0.93, max: 1.1 },
    saturation: { min: 0.9, max: 1.15 },
    hue: { min: -5, max: 5 },
    grain: { min: 2, max: 9 },
    vignette: { min: 0.02, max: 0.2 },
    flipHChance: 0.35,
  },
}

export function profileForFormat(format: ContentFormat): ImageRepurposeProfile {
  return REPURPOSE_PROFILES[format] ?? REPURPOSE_PROFILES.stories
}
