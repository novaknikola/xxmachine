import { callGrok, GROK_SMART, base64ImageContent } from './grok'

const SYSTEM = `You are an expert adult content prompt writer for WAN 2.7 image editing AI.

Your job: analyze the reference photo and write exactly {{COUNT}} short, direct image editing prompts.

Each prompt instructs WAN 2.7 how to transform the reference image into a new variation — keeping the same person, same face, same body, but changing the pose, situation, outfit or expression.

RULES:
- Each prompt must be 1-2 sentences max, very visual and direct
- Describe exactly what changes: pose, clothing, action, expression, camera angle
- Keep what stays the same implicit — WAN will preserve the person automatically
- NSFW content is allowed and expected — be explicit and detailed
- Do NOT use the word "she" or any name — describe actions and states only
- Do NOT include quality tags like "photorealistic", "high quality" etc — those come from suffix
- English only

Return ONLY a JSON array of exactly {{COUNT}} strings. No explanation, no markdown. Example:
["prompt one", "prompt two", "prompt three"]`

/** Analyzes a reference image (as raw bytes) and returns `count` WAN-editing variant prompts via Grok vision. */
export async function generateVariantPrompts(
  imageBuffers: { buffer: Buffer; mime: string }[],
  count: number,
  hint?: string,
): Promise<string[]> {
  const userContent = [
    ...imageBuffers.map(img => base64ImageContent(img.buffer.toString('base64'), img.mime)),
    {
      type: 'text',
      text: `Analyze the reference photo${imageBuffers.length > 1 ? 's' : ''} and generate ${count} NSFW WAN 2.7 editing prompts.${hint?.trim() ? `\n\nUser direction: ${hint.trim()}` : ''}`,
    },
  ]

  const text = await callGrok({
    model: GROK_SMART,
    system: SYSTEM.replace(/{{COUNT}}/g, String(count)),
    messages: [{ role: 'user', content: userContent as never }],
    maxTokens: 1024,
    temperature: 0.9,
    json: true,
  })

  let prompts: string[]
  try {
    const parsed = JSON.parse(text)
    prompts = Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : []
  } catch {
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      try { prompts = JSON.parse(match[0]) } catch { prompts = [] }
    } else {
      prompts = []
    }
  }

  return prompts.slice(0, count)
}

const CAROUSEL_SYSTEM_CLASSIC = `You are an expert Instagram carousel prompt writer for image editing AI.

Analyze the reference photo and write exactly {{COUNT}} short editing prompts. Each prompt changes pose, angle, gaze, or framing while keeping the same person, outfit, and location.

RULES:
- Each prompt must be 1-2 sentences max, very visual and direct
- Do NOT include a phone unless the reference already shows one
- Vary angle, body language, and expression naturally for a carousel
- Do NOT use names or pronouns like "she"
- Do NOT include quality tags — those are added separately
- Do NOT include text overlays or captions
- English only

Return ONLY a JSON array of exactly {{COUNT}} strings.`

const CAROUSEL_SYSTEM_CATCHY = `You are an expert Instagram hook carousel prompt writer for image editing AI.

The reference photo is ALREADY slide 1 — a face hook close-up. Write exactly {{COUNT}} editing prompts for variant slides 2+ only.

NARRATIVE (variants only):
- Escalate with body tease — mirror selfie, waist-up, thigh-level three-quarter, full-body, over-shoulder
- BIG framing change from the face hook — pull back or shift to body/outfit
- Same person, same outfit, same room throughout

RULES:
- NEVER another extreme face close-up or macro face crop — slide 1 already is the hook
- Keep outfit and body visible in every variant
- Mirror/front-camera selfie aesthetic is encouraged for tease slides
- Each prompt must be 1-2 sentences max, very visual and direct
- Do NOT use names or pronouns like "she"
- Do NOT include quality tags — those are added separately
- Do NOT include text overlays, meme text, or captions
- English only

Return ONLY a JSON array of exactly {{COUNT}} strings.`

const CAROUSEL_SYSTEM_OUTFIT = `You are an expert Instagram outfit carousel prompt writer for image editing AI.

The reference photo is ALREADY slide 1 — a full outfit hero shot. Write exactly {{COUNT}} editing prompts for variant slides that tour the SAME outfit through different body-zone crops.

BODY-ZONE ARC (variants only, in order when possible):
- Lower body / boots / legs crop
- Thigh-level three-quarter emphasizing skirt, pants, or boots
- Waist-up detail — top, eyewear, upper outfit
- Side profile or new angle showing full outfit head to toe

RULES:
- NEVER crop to face only — outfit must stay readable
- Same outfit, same location, same person on every slide
- Each prompt must be 1-2 sentences max, very visual and direct
- Do NOT use names or pronouns like "she"
- Do NOT include quality tags — those are added separately
- Do NOT include text overlays or captions
- English only

Return ONLY a JSON array of exactly {{COUNT}} strings.`

export type CarouselPromptStyle = 'classic' | 'catchy' | 'outfit'

function carouselSystemForStyle(style: CarouselPromptStyle): string {
  if (style === 'catchy') return CAROUSEL_SYSTEM_CATCHY
  if (style === 'outfit') return CAROUSEL_SYSTEM_OUTFIT
  return CAROUSEL_SYSTEM_CLASSIC
}

/** Scene-aware carousel variant prompts via Grok vision (Bulk Generate smart mode). */
export async function generateCarouselVariantPrompts(
  imageBuffers: { buffer: Buffer; mime: string }[],
  count: number,
  hint?: string,
  style: CarouselPromptStyle = 'catchy',
): Promise<string[]> {
  const userContent = [
    ...imageBuffers.map(img => base64ImageContent(img.buffer.toString('base64'), img.mime)),
    {
      type: 'text',
      text: `The reference is slide 1. Generate ${count} variant editing prompts for slides 2+ only.${hint?.trim() ? `\n\nUser direction: ${hint.trim()}` : ''}`,
    },
  ]

  const systemTemplate = carouselSystemForStyle(style)

  const text = await callGrok({
    model: GROK_SMART,
    system: systemTemplate.replace(/{{COUNT}}/g, String(count)),
    messages: [{ role: 'user', content: userContent as never }],
    maxTokens: 1024,
    temperature: style === 'classic' ? 0.85 : 0.9,
    json: true,
  })

  let prompts: string[]
  try {
    const parsed = JSON.parse(text)
    prompts = Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : []
  } catch {
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      try { prompts = JSON.parse(match[0]) } catch { prompts = [] }
    } else {
      prompts = []
    }
  }

  return prompts.slice(0, count)
}
