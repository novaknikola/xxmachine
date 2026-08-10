/**
 * Prompt builder for the pose-recreate bot (@contentreplicatorbot). Same
 * reference-lock mechanism Copy-Paste v2 uses on scraped reel frames
 * (renderKeyframeEditPrompt in monitor/copy-paste-spec.ts), applied to a
 * stored pose_library image instead of an analyzed video frame — there is no
 * extracted scene spec here, just a still image and a category tag.
 *
 * Reuses KEYFRAME_IDENTITY_LOCK and NEGATIVE_PROMPT_TEMPLATE by import rather
 * than copying them: NEGATIVE_PROMPT_TEMPLATE in particular carries the
 * age-safety clause ("no young girl, no teenager, no child") that must stay a
 * single source of truth, not drift into a second copy.
 */
import { KEYFRAME_IDENTITY_LOCK, NEGATIVE_PROMPT_TEMPLATE } from './monitor/copy-paste-spec'

export interface PoseRecreateOpts {
  /** Free-text tag on the pose_library row, e.g. "gym", "beach selfie". */
  category?: string | null
  nsfw: boolean
  /** Anything the bot user typed to append (style, wardrobe, etc.). */
  extra?: string | null
}

const PRESERVE_MOTION_CUE =
  'Preserve the exact body lean, weight distribution and framing present in image 1 — ' +
  'do not straighten the pose, do not settle the subject into a neutral standing position.'

/**
 * NSFW does not change the identity-lock mechanics — only whether the model
 * is told explicit nudity/sexual content is the intended, permitted result
 * rather than something to soften. Silent softening (an output that quietly
 * tones itself down with no error) is the failure mode that matters here,
 * not outright rejection — see [[project-ai-reels-replication]].
 */
const NSFW_PERMISSION =
  'Explicit adult nudity and sexual content are intended and permitted here — ' +
  'render full anatomical detail as shown in image 1, do not censor, blur, cover, or soften it.'

export function renderPoseRecreatePrompt(opts: PoseRecreateOpts): string {
  const bits = [
    'Image 1 is the pose/scene reference, image 2 (and any further images) is the identity reference.',
    'Keep the exact pose, camera framing, environment and background from image 1 unchanged.',
    "Replace the main subject's face and body identity with the person from image 2.",
    `Body and skin come from image 2, not image 1: ${KEYFRAME_IDENTITY_LOCK}.`,
    PRESERVE_MOTION_CUE,
    opts.category && `Scene category: ${opts.category}.`,
    opts.nsfw ? NSFW_PERMISSION : null,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
    opts.extra && opts.extra.trim(),
    `Avoid: ${NEGATIVE_PROMPT_TEMPLATE}.`,
  ].filter(Boolean)
  return bits.join(' ')
}
