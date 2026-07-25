import { callGrok, GROK_FAST } from './grok'

export type ShuffleStrength = 'light' | 'medium' | 'heavy'

export const SHUFFLE_BATCH_SIZE = 15

const STRENGTH_INSTRUCTIONS: Record<ShuffleStrength, string> = {
  light: 'Make a subtle wording change — swap a few words for synonyms, keep the same length, tone, and any emoji. It should read as basically the same caption.',
  medium: 'Reword it noticeably — different sentence structure or phrasing — while keeping the core message, tone, and any emoji intact.',
  heavy: 'Rewrite it creatively — you can restructure the sentence and change the phrasing significantly — but keep the core meaning and vibe.',
}

const NEAR_DUP_WORD_OVERLAP = 0.82 // 82%+ shared words across the whole caption = same caption
const TEMPLATE_PREFIX_WORDS = 7    // compare just the opening words too...
const TEMPLATE_PREFIX_OVERLAP = 0.7 // ...at a lower bar, so "Only bright men can read this backwards"
                                     // vs "Only clever men can read this backwards" still gets caught even
                                     // though the (very different) reversed-text payload dilutes whole-text overlap

function normalizedWords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function wordSet(text: string): Set<string> {
  return new Set(normalizedWords(text))
}

function prefixWordSet(text: string): Set<string> {
  return new Set(normalizedWords(text).slice(0, TEMPLATE_PREFIX_WORDS))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

/** True if the same sentence appears more than once inside a single caption (a generation glitch). */
export function hasInternalRepetition(text: string): boolean {
  const sentences = text
    .split(/[\n.!?]+/)
    .map(s => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(s => s.length > 8) // skip short fragments/emoji-only lines — not worth comparing
  const seen = new Set<string>()
  for (const s of sentences) {
    if (seen.has(s)) return true
    seen.add(s)
  }
  return false
}

interface Fingerprint { words: Set<string>; prefix: Set<string> }

function isDuplicateOf(fp: Fingerprint, others: Fingerprint[]): boolean {
  return others.some(o =>
    jaccard(fp.words, o.words) >= NEAR_DUP_WORD_OVERLAP ||
    jaccard(fp.prefix, o.prefix) >= TEMPLATE_PREFIX_OVERLAP,
  )
}

/**
 * Drops exact duplicates (case/whitespace-insensitive) and near-duplicates — captions
 * that reuse the same template with only a word or two swapped, which plain string
 * comparison misses (e.g. "...you two notice..." vs "...you two understand...", or the
 * same "read this backwards" opener reused with a different reversed payload).
 */
export function dedupeCaptions(texts: string[]): string[] {
  const out: string[] = []
  const outFps: Fingerprint[] = []
  const seenExact = new Set<string>()

  for (const raw of texts) {
    const text = raw.trim()
    if (!text) continue

    const exactKey = text.toLowerCase().replace(/\s+/g, ' ')
    if (seenExact.has(exactKey)) continue

    const fp: Fingerprint = { words: wordSet(text), prefix: prefixWordSet(text) }
    if (isDuplicateOf(fp, outFps)) continue

    seenExact.add(exactKey)
    out.push(text)
    outFps.push(fp)
  }
  return out
}

/**
 * Filters `candidates` down to ones that are neither exact nor near-duplicates of
 * anything in `against`, nor of each other, nor internally repetitive. Used to keep
 * freshly-generated captions from repeating the examples they were inspired by,
 * earlier generated batches, or themselves.
 */
export function filterNewCaptions(candidates: string[], against: string[]): string[] {
  const againstFps: Fingerprint[] = against.map(t => ({ words: wordSet(t), prefix: prefixWordSet(t) }))
  const againstExact = new Set(against.map(t => t.toLowerCase().replace(/\s+/g, ' ').trim()))

  const out: string[] = []
  const outFps: Fingerprint[] = []

  for (const raw of candidates) {
    const text = raw.trim()
    if (!text) continue
    if (hasInternalRepetition(text)) continue

    const exactKey = text.toLowerCase().replace(/\s+/g, ' ')
    if (againstExact.has(exactKey)) continue

    const fp: Fingerprint = { words: wordSet(text), prefix: prefixWordSet(text) }
    if (isDuplicateOf(fp, againstFps)) continue
    if (isDuplicateOf(fp, outFps)) continue

    out.push(text)
    outFps.push(fp)
  }
  return out
}

/** Picks a random sample of up to `n` examples (without replacement). */
export function sampleExamples(examples: string[], n: number): string[] {
  if (examples.length <= n) return examples
  const shuffled = [...examples]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

/** Generates brand-new captions inspired by the style/format of `examples` via Grok. */
export async function generateCaptionsBatch(examples: string[], count: number, hint?: string): Promise<string[]> {
  const prompt = `Here are ${examples.length} example captions showing a particular style, tone, and format:

${examples.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Generate ${count} BRAND NEW captions that match the same style, tone, and format as these examples — but with genuinely different content and wording, not reworded copies of the examples. Each one should also be distinct from the others.

Rules:
- Do not reuse the same opening line/gimmick (e.g. "Only ___ men can read this backwards...") across multiple captions in this batch — vary the setup, not just one word in it.
- Never repeat the same sentence twice within a single caption.
- If a caption includes a reversed/backwards-text trick, make sure it's an actual character-reversal of real words, not gibberish.
${hint?.trim() ? `\nAdditional guidance: ${hint.trim()}\n` : ''}
Return ONLY a JSON object: {"captions": ["...", "...", ...]} with exactly ${count} strings.`

  const raw = await callGrok({
    model: GROK_FAST,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
    temperature: 1.0,
    json: true,
  })

  const parsed = JSON.parse(raw) as { captions?: unknown }
  if (!Array.isArray(parsed.captions)) throw new Error('Invalid response: missing captions array')
  return parsed.captions.map(c => String(c).trim()).filter(Boolean)
}

/** Rewrites one batch of captions via Grok, returning the same count in the same order. */
export async function rewriteCaptionsBatch(texts: string[], strength: ShuffleStrength): Promise<string[]> {
  const prompt = `Reword each of these ${texts.length} captions so they are no longer identical/near-identical to each other or to the original — this is to avoid duplicate-content detection when reposting similar content.

${STRENGTH_INSTRUCTIONS[strength]}

Return ONLY a JSON object: {"captions": ["...", "...", ...]} with exactly ${texts.length} strings, in the same order as the input. Do not merge, skip, or add captions.

Input captions:
${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

  const raw = await callGrok({
    model: GROK_FAST,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
    temperature: 0.8,
    json: true,
  })

  const parsed = JSON.parse(raw) as { captions?: unknown }
  if (!Array.isArray(parsed.captions) || parsed.captions.length !== texts.length) {
    throw new Error(`Expected ${texts.length} rewritten captions, got ${Array.isArray(parsed.captions) ? parsed.captions.length : 'invalid response'}`)
  }
  return parsed.captions.map(c => String(c).trim())
}
