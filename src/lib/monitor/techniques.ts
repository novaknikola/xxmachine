import type { VideoTechnique } from './types'

/**
 * Maps a detected technique to the WaveSpeed endpoint that can actually reproduce it.
 *
 * Two techniques are deliberately left unexecutable: `multi_shot` needs per-segment
 * generation plus stitching, and `extend` needs chained continuations. Both are
 * detected and parked for review rather than routed to a model that would silently
 * produce a wrong-looking clip.
 */

const MOTION_CONTROL_MODEL = 'kwaivgi/kling-v2.6-std/motion-control'
/** Handles both plain image-to-video and keyframe interpolation via `last_image`. */
const WAN_I2V_MODEL = 'alibaba/wan-2.7/image-to-video'

export interface TechniquePayloadInput {
  /** Generated first frame carrying our character. */
  imageUrl: string
  /** Generated end frame — only used by first_last_frame. */
  endImageUrl?: string | null
  /** Original reel, used as the motion reference by motion_transfer. */
  sourceVideoUrl?: string | null
  motionPrompt?: string | null
  /** Measured source duration in seconds, if known. */
  duration?: number | null
}

export interface TechniqueSpec {
  id: VideoTechnique
  label: string
  /** Null means the technique is detected but not yet executable. */
  model: string | null
  needsSourceVideo: boolean
  needsEndImage: boolean
  needsMotionPrompt: boolean
  /** Why this technique is parked, shown in the UI when `model` is null. */
  reviewReason?: string
  buildPayload?: (input: TechniquePayloadInput) => Record<string, unknown>
}

/** wan-2.7 accepts discrete clip lengths; anything longer must be extended, not stretched. */
function clampDuration(duration?: number | null): number {
  if (!duration || duration <= 7) return 5
  return 10
}

function wanResolution(): string {
  return '720p'
}

export const TECHNIQUES: Record<VideoTechnique, TechniqueSpec> = {
  motion_transfer: {
    id: 'motion_transfer',
    label: 'Motion transfer',
    model: MOTION_CONTROL_MODEL,
    needsSourceVideo: true,
    needsEndImage: false,
    needsMotionPrompt: false,
    buildPayload: input => ({
      image: input.imageUrl,
      video: input.sourceVideoUrl,
      character_orientation: 'image',
    }),
  },

  image_to_video: {
    id: 'image_to_video',
    label: 'Image to video',
    model: WAN_I2V_MODEL,
    needsSourceVideo: false,
    needsEndImage: false,
    needsMotionPrompt: true,
    buildPayload: input => ({
      image: input.imageUrl,
      prompt: input.motionPrompt ?? '',
      resolution: wanResolution(),
      duration: clampDuration(input.duration),
    }),
  },

  first_last_frame: {
    id: 'first_last_frame',
    label: 'First / last frame',
    model: WAN_I2V_MODEL,
    needsSourceVideo: false,
    needsEndImage: true,
    needsMotionPrompt: true,
    buildPayload: input => ({
      image: input.imageUrl,
      last_image: input.endImageUrl,
      prompt: input.motionPrompt ?? '',
      resolution: wanResolution(),
      duration: clampDuration(input.duration),
    }),
  },

  multi_shot: {
    id: 'multi_shot',
    label: 'Multi-shot sequence',
    // Executed via generation_queue (shared keyframe + per-segment motion transfer + stitch),
    // not a single Wavespeed endpoint — model stays null so the router does not try one-shot.
    model: null,
    needsSourceVideo: true,
    needsEndImage: false,
    needsMotionPrompt: false,
    reviewReason: undefined,
  },

  extend: {
    id: 'extend',
    label: 'Extended shot',
    model: null,
    needsSourceVideo: false,
    needsEndImage: false,
    needsMotionPrompt: false,
    reviewReason: 'Source is longer than a single generation — needs chained continuation',
  },

  unknown: {
    id: 'unknown',
    label: 'Unknown',
    model: null,
    needsSourceVideo: false,
    needsEndImage: false,
    needsMotionPrompt: false,
    reviewReason: 'Technique could not be determined with confidence',
  },
}

export function getTechnique(id: VideoTechnique | null): TechniqueSpec {
  return TECHNIQUES[id ?? 'unknown'] ?? TECHNIQUES.unknown
}

/**
 * Resolves an unroutable or unsupported detection into something we can run.
 * Motion transfer is preferred when a source clip exists because it copies motion
 * literally and therefore needs no correct understanding of the original method.
 */
export function resolveExecutable(
  id: VideoTechnique | null,
  hasSourceVideo: boolean,
): { technique: VideoTechnique; fellBack: boolean } {
  const spec = getTechnique(id)
  if (spec.model && (!spec.needsSourceVideo || hasSourceVideo)) {
    return { technique: spec.id, fellBack: false }
  }
  if (hasSourceVideo) return { technique: 'motion_transfer', fellBack: true }
  return { technique: 'image_to_video', fellBack: true }
}
