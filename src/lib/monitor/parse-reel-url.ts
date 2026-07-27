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
 */
export function parseReelUrl(raw: string): ParsedReelUrl | null {
  const line = raw.trim().replace(/[,\s]+$/, '')
  if (!line || line.startsWith('#')) return null

  // Bare shortcode (11-ish chars, Instagram alphabet)
  if (/^[A-Za-z0-9_-]{5,32}$/.test(line)) {
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

/** Split textarea / clipboard blob into unique parsed reels (order preserved). */
export function parseReelUrlList(text: string, max = 50): {
  parsed: ParsedReelUrl[]
  invalid: string[]
} {
  const lines = text
    .split(/[\n\r]+/)
    .flatMap(line => line.split(/\s+/))
    .map(s => s.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const parsed: ParsedReelUrl[] = []
  const invalid: string[] = []

  for (const line of lines) {
    const p = parseReelUrl(line)
    if (!p) {
      // Skip noise that looked like a separator; keep real junk for feedback.
      if (/^https?:\/\//i.test(line) || line.includes('instagram.com')) {
        invalid.push(line)
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
