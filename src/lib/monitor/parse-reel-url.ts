/** Normalize Instagram reel / post links into shortcode + canonical permalink. */

const IG_HOST = /^(?:www\.)?instagram\.com$/i

export interface ParsedReelUrl {
  shortCode: string
  permalink: string
  /** Present for /@user/reel/CODE or /user/reel/CODE links. */
  ownerUsername?: string
}

const MEDIA_KINDS = new Set(['reel', 'reels', 'p', 'tv'])

/**
 * Accepts full URLs, bare shortcodes, or lines with trailing junk.
 * Returns null when the line is not a recognizable reel/post link.
 *
 * `allowBareShortcode` defaults to true for direct callers (e.g. a single
 * command argument like `/replicate ABC123xyz`, where there's nothing else
 * the token could be). `parseReelUrlList` sets it false for any word pulled
 * out of a multi-word line — see that function's doc comment for why: an
 * isolated word is ambiguous, but a word from a sentence is not.
 */
export function parseReelUrl(raw: string, opts: { allowBareShortcode?: boolean } = {}): ParsedReelUrl | null {
  const { allowBareShortcode = true } = opts
  const line = raw.trim().replace(/[,\s]+$/, '')
  if (!line || line.startsWith('#')) return null

  // Bare shortcode (11-ish chars, Instagram alphabet)
  if (allowBareShortcode && /^[A-Za-z0-9_-]{5,32}$/.test(line)) {
    return {
      shortCode: line,
      permalink: `https://www.instagram.com/reel/${line}/`,
    }
  }

  let url: URL
  try {
    const withProto = /^https?:\/\//i.test(line) ? line : `https://${line}`
    url = new URL(withProto)
  } catch {
    return null
  }

  if (!IG_HOST.test(url.hostname)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  // /reel/CODE, /reels/CODE, /p/CODE, /tv/CODE
  // or /username/reel/CODE (owner embedded in path)
  let kind = parts[0]?.toLowerCase()
  let code = parts[1]
  let ownerUsername: string | undefined

  if (kind && !MEDIA_KINDS.has(kind) && parts.length >= 3) {
    ownerUsername = parts[0].replace(/^@/, '')
    kind = parts[1]?.toLowerCase()
    code = parts[2]
  }

  if (!code || !MEDIA_KINDS.has(kind ?? '')) return null
  if (!/^[A-Za-z0-9_-]{5,32}$/.test(code)) return null

  return {
    shortCode: code,
    permalink: `https://www.instagram.com/reel/${code}/`,
    ownerUsername,
  }
}

/**
 * Split textarea / clipboard blob into unique parsed reels (order preserved).
 *
 * Bare shortcodes (no instagram.com in the token) are only accepted when the
 * token was alone on its original line — a lone word is genuinely ambiguous
 * ("did they paste just a code?"), but a word pulled out of a multi-word line
 * is not: it's prose. Without this, a plain-English instruction sent to the
 * bot (e.g. "increase breasts a little, remove screen") gets shredded one
 * word per token and every 5-32 char word matches the shortcode pattern —
 * confirmed in production 2026-08-13, an 11-word sentence became 11 fake
 * "reel" links alongside the one real one someone actually pasted. Full URLs
 * are unaffected at any position — they never needed the bare-shortcode path.
 */
export function parseReelUrlList(text: string, max = 50): {
  parsed: ParsedReelUrl[]
  invalid: string[]
} {
  const rawLines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
  const tokens: { token: string; allowBareShortcode: boolean }[] = []
  for (const rawLine of rawLines) {
    const parts = rawLine.split(/\s+/).filter(Boolean)
    for (const part of parts) {
      tokens.push({ token: part, allowBareShortcode: parts.length === 1 })
    }
  }

  const seen = new Set<string>()
  const parsed: ParsedReelUrl[] = []
  const invalid: string[] = []

  for (const { token, allowBareShortcode } of tokens) {
    const p = parseReelUrl(token, { allowBareShortcode })
    if (!p) {
      // Skip noise that looked like a separator; keep real junk for feedback.
      if (/^https?:\/\//i.test(token) || token.includes('instagram.com')) {
        invalid.push(token)
      }
      continue
    }
    if (seen.has(p.shortCode)) continue
    seen.add(p.shortCode)
    parsed.push(p)
    if (parsed.length >= max) break
  }

  return { parsed, invalid }
}
