/**
 * youmind.com prompt scraping — PARTIAL. Not wired into anything yet.
 *
 * Status, measured against the portrait-selfie listing: the listing parses
 * cleanly (75 slugs, 13 detail links per page), but only 2 of 13 detail pages
 * carry the real prompt in their server-rendered payload. The other 11 return
 * a byte-identical template object — verified by hashing the extraction across
 * every page on the listing. Their actual prompt is fetched after hydration.
 *
 * So this reaches roughly 15% of prompts as-is. Finishing it needs a headless
 * browser; the client bundles contain no /api route, no GraphQL and no tRPC
 * endpoint to call directly (1 MB searched). Kept because the payload parsing
 * and the two traps below are the expensive part to rediscover.
 *
 * The listing and detail pages are a Next.js app: there is no JSON API, no
 * GraphQL and no /api route in the client bundles. What there is, is the RSC
 * flight payload — the page data streamed as a series of
 * `self.__next_f.push([1,"<chunk>"])` calls. Each chunk is a JS string literal,
 * so it must be unescaped and concatenated before anything inside is readable.
 *
 * Two things that cost time when this was worked out, kept here so they are not
 * rediscovered:
 *
 * - The listing's `slug` field is NOT the URL. Detail pages live at
 *   /prompts/<slug>-<numericId>, and the numeric suffix only appears in the
 *   href, so links are read from the markup rather than rebuilt from slugs.
 * - A detail page has a `content` field of ~676 chars that is identical on
 *   every prompt: site boilerplate, not the prompt. The prompt itself is a
 *   nested JSON object (technical_specs / subject / styling / environment and
 *   friends). Picking "the longest string field" gets the boilerplate every
 *   time.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export class YoumindError extends Error {}

export interface YoumindPrompt {
  /** Stable id from the detail URL's numeric suffix. */
  sourceId: string
  slug: string
  url: string
  title: string | null
  /** The prompt object, serialized — this is what the library stores. */
  prompt: string
  previewImageUrl: string | null
  author: string | null
}

async function getHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Concatenated, unescaped RSC payload for a page. */
export function flightPayload(html: string): string {
  const chunks: string[] = []
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    try {
      chunks.push(JSON.parse('"' + m[1] + '"') as string)
    } catch {
      // One malformed chunk must not cost the rest of the payload.
    }
  }
  return chunks.join('')
}

/** Detail links as they appear in the markup, deduped, in page order. */
export function detailPaths(html: string): string[] {
  const found = [...html.matchAll(/"(\/prompts\/[a-z0-9][a-z0-9-]{6,90}-(\d+))"/g)]
  return [...new Set(found.map(m => m[1]))]
}

/**
 * Carve the balanced { … } that encloses `at`. The payload is one long string
 * rather than parseable JSON, so the object is found by counting braces while
 * respecting string escapes.
 */
function enclosingObject(s: string, at: number): string | null {
  let start = -1
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (s[i] === '}') depth++
    else if (s[i] === '{') {
      if (depth === 0) { start = i; break }
      depth--
    }
  }
  if (start < 0) return null

  let inStr = false
  let esc = false
  depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Keys seen at the top level of a prompt object. Used to tell the prompt apart
 * from the many other objects in the payload — a match needs at least two, so
 * an unrelated object that happens to carry one key is not mistaken for it.
 */
const PROMPT_TOP_KEYS = [
  'technical_specs', 'subject', 'styling', 'environment', 'camera', 'lighting',
  'composition', 'scene', 'meta_data', 'output_schema', 'style', 'pose',
]

/** Markers that live *inside* a prompt object, tried in turn. */
const PROMPT_MARKERS = [
  '"technical_specs"', '"subject"', '"styling"', '"environment"',
  '"facial_expression"', '"hair"', '"lighting"', '"composition"', '"camera"',
]

/**
 * Tell a prompt from the label dictionary.
 *
 * The payload also carries the UI's translation map, which uses the very same
 * top-level names: {"subject":"Subject","lighting":"Lighting","camera":"Camera",
 * "style":"Style"}. It satisfies any test based on key names alone, and quietly
 * passed as eleven of thirteen "successful" extractions on the first run.
 *
 * The difference is the values: labels are all strings, a real prompt nests
 * objects under its sections.
 */
function looksLikePrompt(parsed: Record<string, unknown>): boolean {
  const known = PROMPT_TOP_KEYS.filter(k => k in parsed)
  if (known.length < 2) return false
  const nested = Object.values(parsed).filter(
    v => v !== null && typeof v === 'object',
  ).length
  return nested >= 2
}

/** The prompt object for one detail page, or null when it cannot be isolated. */
export function extractPromptObject(flight: string): string | null {
  for (const marker of PROMPT_MARKERS) {
    let from = 0
    // The same marker can occur several times; only one occurrence is inside
    // the prompt, so every hit is tried before moving to the next marker.
    for (let hit = 0; hit < 6; hit++) {
      const at = flight.indexOf(marker, from)
      if (at < 0) break
      from = at + marker.length

      let cursor = at
      for (let level = 0; level < 6; level++) {
        const obj = enclosingObject(flight, cursor)
        if (!obj) break
        try {
          const parsed = JSON.parse(obj) as Record<string, unknown>
          if (looksLikePrompt(parsed)) return JSON.stringify(parsed, null, 2)
        } catch {
          // Not standalone JSON at this level — climb out one more.
        }
        const idx = flight.indexOf(obj)
        if (idx <= 0) break
        cursor = idx - 1
      }
    }
  }
  return null
}

function firstMatch(flight: string, key: string): string | null {
  const m = flight.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){2,300})"`))
  if (!m) return null
  try {
    return JSON.parse('"' + m[1] + '"') as string
  } catch {
    return m[1]
  }
}

export async function fetchPromptDetail(path: string): Promise<YoumindPrompt | null> {
  const url = `https://youmind.com${path}`
  const html = await getHtml(url)
  if (!html) return null

  const flight = flightPayload(html)
  const prompt = extractPromptObject(flight)
  if (!prompt) return null

  const slugWithId = path.split('/').pop() ?? ''
  const sourceId = slugWithId.match(/-(\d+)$/)?.[1] ?? slugWithId

  return {
    sourceId,
    slug: slugWithId,
    url,
    // Derived from the slug rather than read from the payload: every "title"
    // in there is either the site's <title> or an i18n string, so reading one
    // labelled every prompt "YouMind - AI Creation Agent".
    title: titleFromSlug(slugWithId),
    prompt,
    previewImageUrl:
      html.match(/https:\/\/cms-assets\.youmind\.com\/[^\s"']+\.(?:jpe?g|png|webp)/)?.[0] ?? null,
    author: firstMatch(flight, 'name'),
  }
}

/** "playful-beach-selfie-8043" → "Playful Beach Selfie". */
export function titleFromSlug(slugWithId: string): string {
  const words = slugWithId.replace(/-\d+$/, '').split('-').filter(Boolean)
  return words
    .map(w => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

export interface ScrapeListingResult {
  prompts: YoumindPrompt[]
  /** Detail pages whose prompt object could not be isolated. */
  failed: string[]
}

/**
 * Walk a listing URL and pull every prompt it links to.
 *
 * Pages are fetched one at a time with a pause between them: this is somebody
 * else's site and the whole job is a few dozen requests, so there is nothing to
 * gain by hammering it.
 */
export async function scrapeListing(opts: {
  listingUrl: string
  maxPages?: number
  delayMs?: number
  onProgress?: (msg: string) => void
}): Promise<ScrapeListingResult> {
  const { listingUrl, maxPages = 10, delayMs = 700, onProgress } = opts
  const seen = new Set<string>()
  const prompts: YoumindPrompt[] = []
  const failed: string[] = []

  for (let page = 1; page <= maxPages; page++) {
    const sep = listingUrl.includes('?') ? '&' : '?'
    const pageUrl = page === 1 ? listingUrl : `${listingUrl}${sep}page=${page}`
    const html = await getHtml(pageUrl)
    if (!html) break

    const paths = detailPaths(html).filter(p => !seen.has(p))
    // No new links means pagination is not advancing — stop rather than
    // refetching page 1 until maxPages runs out.
    if (!paths.length) break
    for (const p of paths) seen.add(p)
    onProgress?.(`page ${page}: ${paths.length} new prompt links`)

    for (const path of paths) {
      const detail = await fetchPromptDetail(path)
      if (detail) prompts.push(detail)
      else failed.push(path)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }

  return { prompts, failed }
}
