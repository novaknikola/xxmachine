import type { ContentFormat } from './content-format'

/**
 * `dedupe` — the same shot re-posted across accounts. Changes must defeat
 * perceptual hashing while staying invisible to a viewer.
 *
 * `distinct` — several postable assets out of one generation. A viewer should
 * read them as different photos of the same moment, so framing and grade move
 * far more, and rotation / colour balance / tone curves come into play.
 */
export type RepurposeStrength = 'dedupe' | 'distinct'

export interface ImageRepurposeProfile {
  /** How many unique variants per source image. */
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
  /**
   * How far the crop window may wander from centre. 1 = anywhere inside the
   * frame (can behead a portrait), 0 = always centred. Only matters once the
   * crop is large enough to lose a head, which is why dedupe leaves it at 1.
   */
  centerBias: number
  /** Small rotation in degrees. Corners are hidden by the crop that follows. */
  rotateDeg?: { min: number; max: number }
  /** Midtone colour cast, ffmpeg colorbalance units (-1..1). Warm/cool push. */
  colorBalance?: { min: number; max: number }
  /** ffmpeg `curves=preset=` names; '' means leave the tone curve alone. */
  curvesPresets?: string[]
}

/** Soft uniqueness — strong enough for platform re-upload, invisible to a viewer. */
const DEDUPE: Record<ContentFormat, ImageRepurposeProfile> = {
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
    centerBias: 1,
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
    centerBias: 1,
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
    centerBias: 1,
  },
}

/**
 * Visibly different assets. Framing does most of the work — a 10% and a 26% crop
 * read as a medium shot and a close-up. `centerBias` keeps the window near the
 * middle so the larger crops do not cut the subject's head off.
 *
 * Carousels stay tamer than the rest: slides sit side by side, so a wild grade on
 * one of them breaks the set.
 */
const DISTINCT: Record<ContentFormat, ImageRepurposeProfile> = {
  stories: {
    count: 3,
    cropPct: { min: 0.10, max: 0.28 },
    zoom: { min: 1.0, max: 1.18 },
    brightness: { min: -0.14, max: 0.14 },
    contrast: { min: 0.86, max: 1.2 },
    saturation: { min: 0.75, max: 1.35 },
    hue: { min: -14, max: 14 },
    grain: { min: 4, max: 18 },
    vignette: { min: 0.05, max: 0.42 },
    flipHChance: 0.5,
    centerBias: 0.55,
    rotateDeg: { min: -3.5, max: 3.5 },
    colorBalance: { min: -0.14, max: 0.14 },
    curvesPresets: ['', 'lighter', 'darker', 'medium_contrast', 'linear_contrast', 'vintage'],
  },
  carousels: {
    count: 3,
    cropPct: { min: 0.06, max: 0.16 },
    zoom: { min: 1.0, max: 1.1 },
    brightness: { min: -0.09, max: 0.09 },
    contrast: { min: 0.9, max: 1.14 },
    saturation: { min: 0.85, max: 1.2 },
    hue: { min: -8, max: 8 },
    grain: { min: 2, max: 10 },
    vignette: { min: 0, max: 0.24 },
    flipHChance: 0.3,
    centerBias: 0.6,
    rotateDeg: { min: -1.8, max: 1.8 },
    colorBalance: { min: -0.08, max: 0.08 },
    curvesPresets: ['', 'lighter', 'medium_contrast', 'linear_contrast'],
  },
  reels: {
    count: 3,
    cropPct: { min: 0.08, max: 0.24 },
    zoom: { min: 1.0, max: 1.15 },
    brightness: { min: -0.12, max: 0.12 },
    contrast: { min: 0.88, max: 1.18 },
    saturation: { min: 0.8, max: 1.3 },
    hue: { min: -12, max: 12 },
    grain: { min: 3, max: 15 },
    vignette: { min: 0.02, max: 0.36 },
    flipHChance: 0.45,
    centerBias: 0.55,
    rotateDeg: { min: -3, max: 3 },
    colorBalance: { min: -0.12, max: 0.12 },
    curvesPresets: ['', 'lighter', 'darker', 'medium_contrast', 'vintage'],
  },
}

export const REPURPOSE_PROFILES: Record<
  RepurposeStrength,
  Record<ContentFormat, ImageRepurposeProfile>
> = { dedupe: DEDUPE, distinct: DISTINCT }

export function profileForFormat(
  format: ContentFormat,
  strength: RepurposeStrength = 'dedupe',
): ImageRepurposeProfile {
  const set = REPURPOSE_PROFILES[strength] ?? DEDUPE
  return set[format] ?? set.stories
}
