/**
 * Prompt builder for the pose-recreate bot (@contentreplicatorbot). Same
 * pose/environment reference-lock mechanism Copy-Paste v2 uses on scraped
 * reel frames (renderKeyframeEditPrompt in monitor/copy-paste-spec.ts),
 * applied to a stored pose_library image instead of an analyzed video frame.
 *
 * Reuses NEGATIVE_PROMPT_TEMPLATE by import rather than copying it: it
 * carries the age-safety clause ("no young girl, no teenager, no child")
 * that must stay a single source of truth, not drift into a second copy.
 *
 * Deliberately does NOT reuse KEYFRAME_IDENTITY_LOCK — that constant tells
 * the model to copy body/skin/anatomy 1:1 from the reference photo, which is
 * correct for Copy-Paste (same character across every video) but produced
 * outputs the user flagged as reproducing the real reference photo's body
 * and intimate details too literally here. BODY_STYLE_ONLY below keeps face
 * identity consistent but lets the model generate its own body instead of
 * cloning the reference's.
 */
import { NEGATIVE_PROMPT_TEMPLATE } from './monitor/copy-paste-spec'

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
 * Stronger pose-lock, added after the user reported pose sometimes drifting
 * alongside the (intentionally free) environment change. Nothing here
 * changes the mechanism — Seedream has no structural pose constraint
 * (no ControlNet/skeleton input), so this is prompt wording only and isn't
 * guaranteed to fully eliminate drift, just reduce it.
 */
const POSE_LOCK_STRICT =
  'The pose is a fixed skeleton traced directly from image 1: identical body position, identical joint and limb angles, ' +
  'identical head tilt, identical hand and foot placement, identical camera framing and angle. ' +
  'Do not reinterpret, adjust, soften or naturalize the pose in any way, even if it looks unfamiliar on the new body from image 2.'

/** Placed right after REIMAGINE_ENVIRONMENT so the model cannot read "change everything" as including the pose. */
const ENVIRONMENT_CHANGE_SCOPE =
  'This change applies ONLY to the environment/background — it must NOT affect the pose in any way, which stays exactly as specified above.'

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

/**
 * Deliberately the opposite of Copy-Paste v2's environment lock: this bot's
 * whole point (per the original spec) is same pose, different person, AND a
 * different ambiance — not "same video, different girl". Only pose/framing
 * stay pinned to image 1; everything about the setting is free to change.
 */
const REIMAGINE_ENVIRONMENT =
  'Reimagine the environment, background, room and setting freshly and differently from image 1 — ' +
  'do not copy its specific location, decor or background details. Keep only the general mood implied ' +
  'by the scene category, if one is given.'

const BODY_STYLE_ONLY =
  'Take facial identity and likeness from image 2 — keep the face recognizable and consistent with image 2. ' +
  'Do NOT copy image 2\'s exact body proportions, skin texture, skin markings, or anatomical/intimate details ' +
  '1:1 — generate your own natural body, consistent only with a similar general body type, rather than ' +
  "reproducing the specific real body shown in image 2."

export function renderPoseRecreatePrompt(opts: PoseRecreateOpts): string {
  const bits = [
    'Image 1 is the pose/scene reference, image 2 (and any further images) is the identity reference.',
    'Keep the exact pose from image 1 — body position, limb placement, weight distribution and camera framing/angle.',
    POSE_LOCK_STRICT,
    "Replace the main subject's face and body identity with the person from image 2.",
    BODY_STYLE_ONLY,
    PRESERVE_MOTION_CUE,
    REIMAGINE_ENVIRONMENT,
    ENVIRONMENT_CHANGE_SCOPE,
    opts.category && `Scene category: ${opts.category}.`,
    opts.nsfw ? NSFW_PERMISSION : null,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people.',
    'Final reminder, the single most important constraint: do not change the pose, body position, joint angles, or camera angle in any way.',
    opts.extra && opts.extra.trim(),
    `Avoid: ${NEGATIVE_PROMPT_TEMPLATE}.`,
  ].filter(Boolean)
  return bits.join(' ')
}
