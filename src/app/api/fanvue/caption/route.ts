import { NextRequest, NextResponse } from 'next/server'
import { callGrok, GROK_FAST } from '@/lib/grok'
import { requireOwner } from '@/lib/session'
import { one } from '@/lib/db'

// Each caption call is an independent model invocation with no memory of the previous one, so
// leaving "vary it" to the model produces near-identical output across a batch. Two axes of
// repetition showed up in testing and both need forcing, not hoping:
//  1. Semantic (what the question is ABOUT) — fixed by rotating CATEGORY.
//  2. Structural (HOW the sentence opens) — even across different categories, the model kept
//     defaulting to "What would you [...] while/if [detail]?" every time. Rotating STRUCTURE
//     independently forces a different sentence shape regardless of category.
const CAPTION_CATEGORIES = {
  feeling: "Ask how she's feeling right now, in this exact moment.",
  want_from_her: 'Ask what she wants someone to do to her right now, given her pose.',
  want_to_do: "Ask what the fan would want to do to her right now, given her pose.",
  discovery: 'Ask what the fan would do if he walked in and found her exactly like this.',
  first_thought: 'Ask what the very first thing is that crosses his mind when he sees her like this.',
  forgiveness: "Ask whether he'd forgive her for everything, just because of how she looks.",
  one_wish: 'Ask what he would do to her if he could do just one single thing to her right now.',
} as const

const CAPTION_STRUCTURES = {
  lead_detail: 'Open with the specific visual detail as a short phrase (not a full sentence), THEN ask the question. Do not start with "What".',
  command_tease: 'Open with a short teasing address like "Tell me", "Be honest", or "Look at this and tell me" before the question. Do not start with "What".',
  statement_then_question: 'Make one short declarative statement about the specific detail first, then a short separate question after it. Do not start with "What".',
  direct_plain: 'Ask the question directly with no lead-in phrase at all — but it must still be anchored in a specific detail, not generic. Do not start with "What would" or "What do".',
} as const

type CaptionCategory = keyof typeof CAPTION_CATEGORIES
type CaptionStructure = keyof typeof CAPTION_STRUCTURES
const CATEGORY_KEYS = Object.keys(CAPTION_CATEGORIES) as CaptionCategory[]
const STRUCTURE_KEYS = Object.keys(CAPTION_STRUCTURES) as CaptionStructure[]

// User-defined price ladder (2026-08-20) — content level -> suggested PPV price in cents.
// null = SFW, no price (included in subscription). This is a business call, not ours to tune;
// the price is always a pre-filled suggestion the owner can still edit per photo, never locked.
const CONTENT_LEVEL_PRICES: Record<string, number | null> = {
  sfw: null,
  bikini_visible: 1499,
  topless: 2999,
  fully_nude: 4999,
  toy_oral: 3499,
  toy_penetration: 6999,
}

const CONTENT_LEVEL_DESCRIPTIONS = `- "sfw": no nudity, safe-for-work.
- "bikini_visible": breasts visible/outlined through bikini, sheer, or wet fabric, not exposed.
- "topless": bare/exposed breasts, no covering.
- "fully_nude": fully nude, no sex toy or explicit act.
- "toy_oral": mouth on a dildo/sex toy.
- "toy_penetration": dildo/sex toy inserted vaginally.`

function buildSystemPrompt(category: CaptionCategory, structure: CaptionStructure): string {
  return `You do two things with the photo shown to you, and respond with a JSON object.

TASK 1 — caption: write a short Fanvue post caption in the form of a single direct, provocative
QUESTION addressed to the fan looking at the photo.

This specific caption's question is about: ${CAPTION_CATEGORIES[category]}
This specific caption's sentence shape: ${CAPTION_STRUCTURES[structure]}

CRITICAL — anchoring: the question must be anchored in something specific and visible in THIS
exact photo — her pose, her expression, what she's doing, where she is, an object or detail in
frame, the mood of the moment. Weave that detail naturally into the sentence. If your draft could
be pasted under a completely different photo unchanged, it has failed — look again and use
something you actually see in this one.

CRITICAL — sentence shape: follow the sentence-shape instruction above exactly. Do not fall back
to the generic pattern "What would you [...] while/if [detail]?" — that exact skeleton is banned
regardless of which detail fills it in.

Caption rules:
- Exactly one question (or lead-in + question per the sentence shape above), casual and teasing tone.
- No hashtags, no emoji spam (at most one emoji), no explicit/graphic language.
- Never mention prices, PPV, or "unlock" in the caption text itself — that's handled separately.

TASK 2 — contentLevel: classify the photo's explicitness into exactly one of these levels:
${CONTENT_LEVEL_DESCRIPTIONS}
Pick the single level that best matches what is actually visible. Default to "sfw" if unsure.

Respond with ONLY a JSON object, no other text: {"caption": "...", "contentLevel": "..."}`
}

export async function POST(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const body = await req.json().catch(() => null) as
    { imageUrl?: string; context?: string; category?: string; structure?: string } | null
  if (!body?.imageUrl) {
    return NextResponse.json({ error: 'missing_imageUrl' }, { status: 400 })
  }

  const category: CaptionCategory = (body.category && body.category in CAPTION_CATEGORIES)
    ? body.category as CaptionCategory
    : CATEGORY_KEYS[Math.floor(Math.random() * CATEGORY_KEYS.length)]
  const structure: CaptionStructure = (body.structure && body.structure in CAPTION_STRUCTURES)
    ? body.structure as CaptionStructure
    : STRUCTURE_KEYS[Math.floor(Math.random() * STRUCTURE_KEYS.length)]

  try {
    const raw = await callGrok({
      model: GROK_FAST,
      system: buildSystemPrompt(category, structure),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: body.context?.trim() || 'Write a caption for this photo.' },
          { type: 'image_url', image_url: { url: body.imageUrl } },
        ],
      }],
      maxTokens: 250,
      temperature: 0.9,
      json: true,
    })
    const parsed = JSON.parse(raw) as { caption?: string; contentLevel?: string }
    const caption = (parsed.caption ?? '').trim()
    if (!caption) throw new Error('empty_caption_in_response')
    const contentLevel = parsed.contentLevel && parsed.contentLevel in CONTENT_LEVEL_PRICES
      ? parsed.contentLevel
      : 'sfw'
    const priceCents = CONTENT_LEVEL_PRICES[contentLevel]

    // Saved automatically so it can be reused later without spending another Grok call —
    // this is the only place captions get written to the library, not a separate opt-in.
    await one(
      `INSERT INTO fanvue_caption_library (caption, category, structure, content_level, price_cents, source_image_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [caption, category, structure, contentLevel, priceCents, body.imageUrl],
    ).catch(() => {})

    return NextResponse.json({ caption, category, structure, contentLevel, priceCents })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    return NextResponse.json({ error: 'caption_failed', detail: msg }, { status: 502 })
  }
}
