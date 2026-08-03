/**
 * Turn a still into a Seedance i2v prompt.
 *
 * The motion is not written by the model. It is a closed set — look at camera,
 * tilt the head, a soft smile or a wink — and which variant fits depends only
 * on the kind of shot. So the vision call does the one thing a lookup table
 * cannot (describe who is in the frame and what they are wearing) and the
 * movement comes from MOTION_BY_SHOT.
 *
 * That split is deliberate: asking a model to invent motion on every image
 * gives drift between clips and pays for reasoning that was already decided.
 * Uniqueness comes from the per-image description plus a random seed, not from
 * the movement, which should be the predictable part. Same shape as
 * CAROUSEL_PRESETS.
 */
import { callGrok, GROK_FAST } from './grok'

export const SHOT_TYPES = ['gym_selfie', 'mirror_selfie', 'portrait_selfie', 'regular'] as const
export type ShotType = typeof SHOT_TYPES[number]

export interface ShotMotion {
  label: string
  /** Appended to the description — what the subject does over the clip. */
  motion: string
  /**
   * A phone held in the hand never sits perfectly still, so selfies read as
   * fake when the camera is locked. A photo taken *of* someone does not have
   * that problem and looks better on a tripod.
   */
  cameraFixed: boolean
}

export const MOTION_BY_SHOT: Record<ShotType, ShotMotion> = {
  gym_selfie: {
    label: 'Gym selfie',
    motion:
      'She looks directly into the camera, tilts her head slightly, and gives a small confident smile. ' +
      'Her breathing is visible and relaxed. Minimal movement, no walking, no gesture changes.',
    cameraFixed: false,
  },
  mirror_selfie: {
    label: 'Mirror selfie',
    motion:
      'She holds her pose and looks into the camera through the mirror, tilting her head slightly ' +
      'and giving a soft smile. The phone stays where it is. Minimal movement, no step, no turn.',
    cameraFixed: false,
  },
  portrait_selfie: {
    label: 'Portrait selfie',
    motion:
      'She looks straight into the camera, tilts her head gently to one side, and gives a subtle smile, ' +
      'then a slow blink. Shoulders stay still. Minimal movement.',
    cameraFixed: true,
  },
  regular: {
    label: 'Regular photo',
    motion:
      'She turns her gaze to the camera, tilts her head slightly, and gives a light smile or a quick wink. ' +
      'Her posture is unchanged. Minimal movement, no walking.',
    cameraFixed: true,
  },
}

/** Closing clause — keeps every clip in the same visual register. */
const STYLE_TAIL =
  'Photorealistic style, clean composition, natural skin texture, soft focus background, ' +
  'no beauty filter, no AI skin smoothing, no scene change, no camera cut.'

export interface FrameAnalysis {
  shotType: ShotType
  /** Who is in frame — hair, skin, features, expression. */
  subject: string
  outfit: string
  setting: string
}

const SYSTEM = `You describe a single photograph so it can be animated. Reply with JSON only:

{
  "shot_type": "gym_selfie | mirror_selfie | portrait_selfie | regular",
  "subject": "the person: age impression, hair colour/length/style, skin tone, notable physical features, jewellery",
  "outfit": "the garments, with colours and fabric",
  "setting": "where she is and what the light is doing"
}

Rules:
- Describe only what is visible. Never invent a detail you cannot see.
- shot_type: mirror_selfie when a mirror or a held phone is visible; gym_selfie in a gym or with equipment; portrait_selfie for a close head-and-shoulders shot taken at arm's length; regular for anything photographed by someone else.
- NEVER mention her expression, her gaze, or where she is looking. The animation
  decides those, and a still that says "looking to the side" fights a clip that
  says "looking into the camera".
- Do NOT describe movement, camera behaviour or video direction. Only the still.
- Write each field as a bare fragment, not a sentence: no leading "She is",
  no "Wearing", no trailing full stop. One clause each.`

/** One cheap vision call — classification and appearance, nothing more. */
export async function analyseFrame(imageUrl: string): Promise<FrameAnalysis> {
  const raw = await callGrok({
    model: GROK_FAST,
    json: true,
    system: SYSTEM,
    maxTokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: 'Describe this photograph as specified.' },
      ],
    }],
  })

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('Frame analysis did not return JSON')
  }

  const shotRaw = String(parsed.shot_type ?? '').trim() as ShotType
  return {
    // An unrecognised label falls back to the least assuming motion rather
    // than failing the image.
    shotType: SHOT_TYPES.includes(shotRaw) ? shotRaw : 'regular',
    subject: String(parsed.subject ?? '').trim(),
    outfit: String(parsed.outfit ?? '').trim(),
    setting: String(parsed.setting ?? '').trim(),
  }
}

export interface ComposedPrompt {
  prompt: string
  shotType: ShotType
  cameraFixed: boolean
}

/**
 * Fold a field into the middle of a sentence.
 *
 * The model is asked for bare fragments but does not always comply, and the
 * failures are visible in the output: "She is wearing She is wearing a cropped
 * hoodie", and a capital letter mid-sentence. Cheaper to normalise here than to
 * keep tightening the instruction.
 */
function fragment(raw: string, stripLead?: RegExp): string {
  let s = raw.trim().replace(/\.+$/, '')
  if (stripLead) s = s.replace(stripLead, '')
  s = s.trim()
  if (!s) return ''
  // Lowercase a leading capital unless it is an acronym or a proper noun run.
  if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

/** Assemble the analysis and the shot's motion into one prompt. */
export function composePrompt(analysis: FrameAnalysis): ComposedPrompt {
  const motion = MOTION_BY_SHOT[analysis.shotType]
  const subject = fragment(analysis.subject) || 'a young woman'
  const outfit = fragment(analysis.outfit, /^(she\s+is\s+)?wearing\s+/i)
  const setting = fragment(analysis.setting)

  const parts = [
    `A vertical 9:16 portrait video of ${subject}.`,
    outfit ? `She is wearing ${outfit}.` : '',
    setting ? `${setting}.` : '',
    motion.motion,
    STYLE_TAIL,
  ].filter(Boolean)

  return {
    prompt: parts.join(' ').replace(/\s+/g, ' ').replace(/\.{2,}/g, '.').trim(),
    shotType: analysis.shotType,
    cameraFixed: motion.cameraFixed,
  }
}

export async function promptForImage(imageUrl: string): Promise<ComposedPrompt & { analysis: FrameAnalysis }> {
  const analysis = await analyseFrame(imageUrl)
  return { ...composePrompt(analysis), analysis }
}
