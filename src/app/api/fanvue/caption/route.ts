import { NextRequest, NextResponse } from 'next/server'
import { callGrok, GROK_FAST } from '@/lib/grok'
import { requireOwner } from '@/lib/session'
import { one } from '@/lib/db'

// Each caption call is an independent model invocation with no memory of the previous one, so
// leaving "vary it" to the model produces near-identical output across a batch. Two axes of
// repetition need forcing, not hoping:
//  1. Semantic (the narrative angle) — fixed by rotating CATEGORY.
//  2. Form (statement vs question, how it opens) — rotating STRUCTURE independently forces a
//     different shape regardless of angle.
// Replaces an earlier version that forced every caption into a single-question mold (real
// captions the user wanted mimicked are mostly NOT questions — see STYLE_REFERENCE below).
const CAPTION_CATEGORIES = {
  secretive_reveal: "Frame this as something she wasn't planning to share, or wasn't supposed to be seen yet — an accidental or impulsive reveal.",
  hesitant_share: 'Frame this as something she almost decided not to post, or took for herself but is sharing anyway.',
  confident_mood: "A short statement about how she's feeling right now — confident, pretty, in a good mood — as the reason she's sharing this.",
  engagement_question: 'A short, casual question inviting him to respond — asking if he wants more like this, or if he likes this side of her.',
  playful_awareness: "A playful, knowing statement or question about exactly what he's noticing or staring at.",
  permission_tease: 'A statement giving him permission to look, paired with a light, secretive reassurance.',
  upsell_tease: "A statement teasing that there's more to see — a fuller set, a reason this one was saved for him.",
  reward_gift: "Frame this photo as a small gift or reward she's giving him.",
  knowing_inevitability: 'A short, confident statement that she just had to share this one with him — no explanation needed.',
  first_reaction_prompt: 'Ask him to tell you his first reaction or thought the moment he saw this.',
} as const

const CAPTION_STRUCTURES = {
  statement_confession: "Write it as a first-person statement or confession — no question mark. A trailing '…' is welcome.",
  playful_tease: 'Write it as a short, playful or secretive tease — a statement, not a question.',
  short_question: 'Write it as one short, casual question — natural, the way someone would actually text it, not elaborate or detail-heavy.',
  reward_framing: 'Write it as a statement that frames this photo as a gift, reward, or something earned — not a question.',
} as const

// Real examples of the target tone — not to be copied, just to give the model something
// concrete to draw the register and rhythm from instead of an abstract description.
const STYLE_REFERENCE = [
  'You weren’t supposed to see this yet 👀',
  'Be honest… how long did you stare? 🤭',
  'I almost didn’t post this one…',
  'Okay, I think this might be my favorite one yet 🫣',
  'Should I post more like this?',
  'There’s a reason I saved this one for you 😏',
  'Just a little something to make your day better…',
  'I know exactly which part you’re looking at 👀',
  'You can look… I won’t tell anyone 🤫',
  'This one hits different when you see the full set…',
  'I wonder what you’d say if you were here right now.',
  'I wasn’t planning on sending this… but here we are 😈',
  'Just me, feeling way too confident today.',
  'I felt pretty in this one, so I had to share it with you ❤️',
  'A little private moment that I decided to make less private.',
  'You know I had to show you this one.',
  'Tell me your first thought when you opened this 👀',
  'I took this for myself… but I think you’ll appreciate it too.',
  'Do you like this side of me?',
  'Okay… I think you deserve this one.',
].map(l => `"${l}"`).join('\n')

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

TASK 1 — caption: write a short Fanvue post caption for this photo.

STYLE REFERENCE — real examples of the exact tone and format wanted. Do not copy these, write
something new in the same spirit:
${STYLE_REFERENCE}

This specific caption's narrative angle: ${CAPTION_CATEGORIES[category]}
This specific caption's form: ${CAPTION_STRUCTURES[structure]}

CRITICAL — most of the reference lines above are NOT questions — they're statements, confessions,
teases, or reveals about the photo or the moment of sharing it, not descriptions of the photo
itself. Only write an actual question when the form instruction above specifically calls for one.
Do not default back to a question just because it feels safer.

CRITICAL — tone: short, natural, confiding — like a real text message to someone she's into, not a
marketing caption. A trailing "…" is fine and used often in the reference. At most one emoji, and
only if it fits naturally — several of the best reference lines use none at all.

Caption rules:
- One short sentence, sometimes two (a lead-in plus the line itself).
- No hashtags, no emoji spam, no explicit/graphic language.
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
