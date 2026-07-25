/** Shared carousel pose presets for Bulk Generate and Carousel tab. */

export interface CarouselPreset {
  id: string
  name: string
  /** Appended to each variant prompt when calling Seedream edit. */
  suffix: string
  prompts: string[]
  builtIn?: boolean
  /** Pick first N prompts in order (story arc) instead of shuffling. */
  ordered?: boolean
  /** Always allow phone/mirror/selfie prompts regardless of base scene. */
  allowPhone?: boolean
  /** Suggested number of variant slides (base is separate). */
  defaultExtras?: 1 | 2 | 3 | 4
}

export const HOOK_TEASE_BASE_DIRECTIVE =
  'extreme close-up portrait hook shot, face fills most of the frame, direct eye contact, lips slightly parted, scroll-stopping expression, shallow depth of field'

export const OUTFIT_TOUR_BASE_DIRECTIVE =
  'full outfit hero shot, head to toe visible, confident stance, entire look clearly readable, editorial framing'

/** Adjust the text2img base prompt for carousel presets that need a specific slide-1 framing. */
export function buildCarouselBasePrompt(scenePrompt: string, presetId: string): string {
  if (presetId === 'hook-tease') {
    return `${scenePrompt}, ${HOOK_TEASE_BASE_DIRECTIVE}`
  }
  if (presetId === 'outfit-tour') {
    return `${scenePrompt}, ${OUTFIT_TOUR_BASE_DIRECTIVE}`
  }
  return scenePrompt
}

export const CAROUSEL_PRESETS: CarouselPreset[] = [
  {
    id: 'hook-tease',
    name: 'Hook & Tease',
    suffix:
      'photorealistic, Instagram hook carousel tease slide. Same outfit and room. ' +
      'Keep body and outfit visible — do NOT crop to face only.',
    ordered: true,
    allowPhone: true,
    defaultExtras: 1,
    builtIn: true,
    prompts: [
      'Mirror selfie tease — waist-up or full body visible, warm soft light, relaxed teasing expression, same outfit and room, front-camera energy.',
      'Three-quarter body shot from thigh level — confident teasing posture, outfit fully visible, same location.',
      'Over-shoulder glance back — playful teasing look, upper body and outfit in frame, candid intimate moment.',
      'Full-body shot — subtle outfit tease, confident posture, same environment, medium-wide framing.',
    ],
  },
  {
    id: 'outfit-tour',
    name: 'Outfit Tour',
    suffix:
      'same outfit, same location, same person, photorealistic. ' +
      'Emphasize the specified body zone and outfit details — do NOT crop to face only.',
    ordered: true,
    defaultExtras: 3,
    builtIn: true,
    prompts: [
      'Crop from hips down — boots, tights, and skirt or pants fill the frame, lower body and footwear emphasized.',
      'Three-quarter from thigh level — outfit texture, skirt or jeans, boots and legs visible, dynamic stance.',
      'Waist-up medium shot — top, eyewear, and upper outfit details sharp, confident pose, soft background.',
      'Side profile full outfit — head to toe visible, same look from a new angle, editorial pose.',
    ],
  },
  {
    id: 'body-language',
    name: 'Body Language',
    suffix: 'photorealistic, natural posture, same outfit and location.',
    builtIn: true,
    prompts: [
      'Three-quarter angle — camera rotated slightly to the right. Same scene.',
      'Looking away from camera, candid over-the-shoulder moment.',
      'Leaning against wall — casual, one shoulder back, relaxed gaze.',
      'Seated relaxed — sitting naturally, weight to one side, comfortable and open.',
      'Dynamic movement — mid-step or turning, energy and motion implied.',
      'Intimate and close — leaning toward camera, soft and inviting.',
      'Standing tall — confident upright posture, hands relaxed at sides.',
      'Soft genuine smile — warm, approachable, slight eye crinkle.',
    ],
  },
  {
    id: 'mood-shift',
    name: 'Mood Shift',
    suffix: 'photorealistic, expressive, consistent outfit and setting.',
    builtIn: true,
    prompts: [
      'Neutral calm expression — composed, still, direct eye contact, serene.',
      'Soft genuine smile — warm, approachable, slight eye crinkle.',
      'Head thrown back laughing — full candid laugh, natural and unguarded.',
      'Thoughtful and distant — looking away, slightly introspective.',
      'Playful smirk — one eyebrow raised, teasing expression.',
      'Direct intense gaze — chin slightly lowered, eyes locked on camera.',
    ],
  },
  {
    id: 'crop-zoom',
    name: 'Crop & Zoom',
    suffix: 'sharp focus, consistent lighting and expression throughout.',
    builtIn: true,
    prompts: [
      'Three-quarter — waist to head, relaxed posture, background softly visible.',
      'Close-up framing — camera zoomed closer, face fills more of frame.',
      'Low camera angle slightly upward from waist level. Same scene.',
      'Waist up — torso and face, hands partially visible, medium crop.',
      'Bust shot — shoulders and face only, intimate but not extreme.',
      'Full body shot — head to toe, natural standing pose, full environment visible.',
    ],
  },
  {
    id: 'candid-dump',
    name: 'Candid Dump',
    suffix: 'film grain, warm tones, authentic candid moment, natural imperfection.',
    builtIn: true,
    prompts: [
      'Street walk — caught mid-stride, golden hour, casual outfit.',
      'Golden hour outdoor — face lit by low sun, eyes slightly squinted, natural smile.',
      'Morning routine — sipping coffee by window, soft natural light, cozy and unstaged.',
      'Thoughtful pause — looking down then glancing up at camera, natural transition.',
      'Wind in hair — caught mid-movement, hair lifted, candid energy.',
    ],
  },
  {
    id: 'camera-angles',
    name: 'Camera Angles',
    suffix: 'photorealistic, sharp detail, natural lighting. Keep outfit, background identical.',
    builtIn: true,
    prompts: [
      'Three-quarter angle — camera rotated slightly to the right. Same scene.',
      'She looks away from camera, candid over-the-shoulder moment.',
      'Close-up framing — camera zoomed closer, face fills more of frame.',
      'Low camera angle slightly upward from waist level. Same scene.',
      'High angle — camera slightly above eye level, soft downward perspective.',
      'Front camera selfie — holds phone toward camera, candid natural expression.',
      'Mirror moment — bathroom or bedroom mirror selfie, relaxed expression, authentic.',
    ],
  },
]

export const DEFAULT_CAROUSEL_PRESET_ID = 'hook-tease'

export function getDefaultCarouselPreset(): CarouselPreset {
  return CAROUSEL_PRESETS.find(p => p.id === DEFAULT_CAROUSEL_PRESET_ID) ?? CAROUSEL_PRESETS[0]
}

export function getCarouselPreset(presetId: string): CarouselPreset {
  return CAROUSEL_PRESETS.find(p => p.id === presetId) ?? getDefaultCarouselPreset()
}

export function recommendedCarouselExtras(presetId: string): 1 | 2 | 3 | 4 {
  return getCarouselPreset(presetId).defaultExtras ?? 1
}

export type CarouselGrokStyle = 'catchy' | 'outfit' | 'classic'

export function getCarouselGrokStyle(presetId: string): CarouselGrokStyle {
  if (presetId === 'hook-tease') return 'catchy'
  if (presetId === 'outfit-tour') return 'outfit'
  return 'classic'
}

const PHONE_RE = /\b(phone|selfie|mirror|front camera|smartphone)\b/i

export function isSelfieScene(prompt: string): boolean {
  return PHONE_RE.test(prompt)
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Pick `count` variant edit prompts from a preset, skipping phone poses unless the scene is already selfie-themed. */
export function getCarouselVariantPrompts(
  presetId: string,
  count: number,
  scenePrompt?: string,
): string[] {
  const preset = getCarouselPreset(presetId)
  const allowPhone = preset.allowPhone || isSelfieScene(scenePrompt ?? '')
  let pool = preset.prompts.filter(p => allowPhone || !PHONE_RE.test(p))
  if (!pool.length) pool = [...preset.prompts]
  const picked = preset.ordered
    ? pool.slice(0, Math.max(0, count))
    : shuffle(pool).slice(0, Math.max(0, count))
  return picked.map(p => `${p} ${preset.suffix}`.trim())
}

/** Variant slides for Hook & Tease — reference is already slide-1 face hook. */
export const CAROUSEL_GROK_HINT_CATCHY =
  'The reference photo is slide 1 (face hook close-up). Generate variant slides 2+ ONLY. ' +
  'Escalate with body tease — mirror selfie, waist-up, thigh-level three-quarter, or full-body. ' +
  'NEVER another extreme face close-up. Keep outfit and body visible. Same person and room. ' +
  'Do NOT include text overlays or captions.'

/** Variant slides for Outfit Tour — reference is slide-1 full outfit hero. */
export const CAROUSEL_GROK_HINT_OUTFIT =
  'The reference photo is slide 1 (full outfit hero). Generate variant slides that tour the SAME outfit ' +
  'through different body-zone crops — legs and boots, thigh-level three-quarter, waist-up detail, side profile full body. ' +
  'NEVER crop to face only. Same location and look throughout. Do NOT include text overlays or captions.'

/** Classic editorial carousel — same scene, varied poses. */
export const CAROUSEL_GROK_HINT_CLASSIC =
  'Generate Instagram carousel pose variants. Same outfit, same location, same person. ' +
  'Vary angle, gaze, and body language naturally. Do NOT include a phone unless the reference already shows one.'

export function getCarouselGrokHint(presetId: string): string {
  const style = getCarouselGrokStyle(presetId)
  if (style === 'catchy') return CAROUSEL_GROK_HINT_CATCHY
  if (style === 'outfit') return CAROUSEL_GROK_HINT_OUTFIT
  return CAROUSEL_GROK_HINT_CLASSIC
}

/** @deprecated Use getCarouselGrokHint — kept for stale imports. */
export const CAROUSEL_GROK_HINT = CAROUSEL_GROK_HINT_CATCHY

/** @deprecated Use getCarouselVariantPrompts — kept for any stale imports. */
export const CAROUSEL_ANGLE_PROMPTS = CAROUSEL_PRESETS.find(p => p.id === 'camera-angles')!.prompts
