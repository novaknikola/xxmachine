/**
 * Pinterest board ingestion.
 *
 * Pinterest's official v5 API only exposes boards belonging to the account that
 * authorised the app, and only after app review — it cannot read someone else's
 * board, and it has no public search. So boards are read the way a browser
 * reads them, from two public surfaces:
 *
 *   1. `<board>.rss`  — a published feed. Clean XML: title, pin URL, image.
 *                       Only carries the newest ~25 pins.
 *   2. the board page — same HTML any visitor gets (no login wall). Yields
 *                       roughly 5x more images but no per-pin titles.
 *
 * RSS is preferred per pin because it carries a title and a real pin id; the
 * page fills in the rest of the board. Pin *search* is deliberately absent:
 * Pinterest renders search results client-side, so a plain fetch of
 * /search/pins/ returns zero images. Searching happens over imported pins.
 *
 * Nothing here downloads an image. i.pinimg.com is an unsigned, non-expiring,
 * referer-free CDN, so pins are stored and used as URLs — see scene-refs.ts.
 */
import { fetchPublicUrl } from './public-fetch'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export interface ParsedBoardRef {
  owner: string
  slug: string
  boardKey: string
  boardUrl: string
}

export interface ParsedPin {
  pinKey: string
  pinUrl: string | null
  title: string | null
  imageUrl: string
  imageUrlHd: string
}

export class PinterestError extends Error {}

/**
 * Accepts a full board URL or a bare "owner/slug". Regional hosts
 * (uk.pinterest.com, pin.it) are normalised to the canonical host.
 */
export function parseBoardRef(input: string): ParsedBoardRef {
  const raw = input.trim()
  if (!raw) throw new PinterestError('Enter a board URL')

  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new PinterestError('Not a valid URL')
    }
    if (!/(^|\.)pinterest\.[a-z.]+$/i.test(url.hostname)) {
      throw new PinterestError('Not a pinterest.com URL')
    }
    path = url.pathname
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new PinterestError('Expected a board URL like pinterest.com/<user>/<board>')
  }
  // A pin permalink is /pin/<id> — a board needs an owner and a slug.
  if (parts[0].toLowerCase() === 'pin') {
    throw new PinterestError('That is a single pin, not a board')
  }
  const [owner, slug] = parts
  return {
    owner,
    slug,
    boardKey: `${owner}/${slug}`,
    boardUrl: `https://www.pinterest.com/${owner}/${slug}/`,
  }
}

/**
 * Pinterest serves the same image under a size segment: /236x/, /736x/,
 * /originals/. Swapping to originals is what turns a grid thumbnail into a
 * generation-quality reference.
 */
export function toOriginalsUrl(imageUrl: string): string {
  return imageUrl.replace(/\/\d+x\//, '/originals/')
}

/** The /ab/cd/ef/<hash>.jpg part, stable across size variants. */
function imageHashKey(imageUrl: string): string | null {
  const m = imageUrl.match(/i\.pinimg\.com\/[^/]+\/(.+)$/)
  return m ? m[1] : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

async function getText(url: string): Promise<{ text: string | null; status: number | 'unreachable' }> {
  try {
    const res = await fetchPublicUrl(url, { headers: { 'User-Agent': UA, Accept: '*/*' } })
    // The status is kept even on failure: a 403 and a 404 mean different
    // things to whoever pasted the URL, and "no pins found" told them neither.
    if (!res.ok) return { text: null, status: res.status }
    return { text: await res.text(), status: res.status }
  } catch {
    return { text: null, status: 'unreachable' }
  }
}

/** Newest pins, with titles and real pin ids. */
export function parseRssPins(xml: string): ParsedPin[] {
  const pins: ParsedPin[] = []
  for (const block of xml.split('<item>').slice(1)) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]
    const desc = block.match(/<description>([\s\S]*?)<\/description>/)?.[1]
    if (!desc) continue

    const img = decodeEntities(desc).match(/<img src="([^"]+)"/)?.[1]
    if (!img || !img.includes('i.pinimg.com')) continue

    const pinId = link?.match(/\/pin\/(\d+)/)?.[1]
    const pinKey = pinId ?? imageHashKey(img)
    if (!pinKey) continue

    pins.push({
      pinKey,
      pinUrl: link ? decodeEntities(link).trim() : null,
      title: title ? decodeEntities(title).trim() || null : null,
      imageUrl: img,
      imageUrlHd: toOriginalsUrl(img),
    })
  }
  return pins
}

/**
 * Every distinct pin image on the board page. No titles here — the page is
 * scraped for breadth, RSS supplies the labels for the pins it covers.
 */
export function parseBoardPagePins(html: string): ParsedPin[] {
  // Content pins live under a size segment that is digits then "x" (236x, 736x)
  // or under originals. Avatars and UI chrome use /75x75_RS/, /140x140_RS/ and
  // friends, which this deliberately does not match.
  const re = /https:\/\/i\.pinimg\.com\/(?:\d+x|originals)\/[a-z0-9/]+\.(?:jpg|jpeg|png|webp)/gi

  const first = new Map<string, string>()
  const hits = new Map<string, number>()
  for (const url of html.match(re) ?? []) {
    const key = imageHashKey(url)
    if (!key) continue
    hits.set(key, (hits.get(key) ?? 0) + 1)
    if (!first.has(key)) first.set(key, url)
  }

  const pins: ParsedPin[] = []
  for (const [key, url] of first) {
    // A real pin is rendered at several widths, so its hash occurs more than
    // once. Page chrome appears exactly once — notably the board's og:image,
    // which on these pages is Pinterest's own default share graphic and was
    // otherwise imported as the first "pin" of every board.
    if ((hits.get(key) ?? 0) < 2) continue
    pins.push({ pinKey: key, pinUrl: null, title: null, imageUrl: url, imageUrlHd: toOriginalsUrl(url) })
  }
  return pins
}

export interface FetchedBoard {
  title: string | null
  pins: ParsedPin[]
  /** What each surface actually returned — the difference between "private" and "we broke". */
  diagnostics: BoardDiagnostics
}

export interface BoardDiagnostics {
  rssStatus: number | 'unreachable'
  pageStatus: number | 'unreachable'
  pageBytes: number
  /** Every i.pinimg.com reference in the page, before any filtering. */
  rawImageRefs: number
  /** Distinct images after the size-segment rule (content sizes, not avatars). */
  uniqueImages: number
  /** Dropped as page chrome — a hash appearing only once, e.g. the board's og:image. */
  droppedAsChrome: number
  rssItems: number
}

/** Human-readable reason a board came back with nothing. */
export function explainEmptyBoard(d: BoardDiagnostics): string {
  if (d.pageStatus === 404) return 'That board URL returns 404 — check the owner and slug.'
  if (d.pageStatus === 403 || d.rssStatus === 403) return 'Pinterest refused the request (403) — the board is private, or the IP is being blocked.'
  if (d.pageStatus === 'unreachable') return 'Could not reach pinterest.com at all.'
  if (d.rawImageRefs === 0) {
    return `The board page loaded (${Math.round(d.pageBytes / 1024)}KB) but contained no pin images at all — an empty board, or one whose contents load only after sign-in.`
  }
  if (d.uniqueImages === 0) {
    return `Found ${d.rawImageRefs} image references but none at a content size — the page may be showing only avatars and UI, which usually means the board is private.`
  }
  // Everything was filtered: worth naming, because it points at our own rule
  // rather than at Pinterest.
  return `Found ${d.uniqueImages} distinct images but all ${d.droppedAsChrome} were treated as page chrome. That is our filter being wrong for this board, not an empty board — report it.`
}

/** Widest size Pinterest reliably serves when /originals/ is missing. */
const FALLBACK_SIZE = '736x'

/**
 * Not every pin has an /originals/ variant — a fair share answer 403 there.
 * Sending one of those to Seedream fails the job, so each pin's HD URL is
 * confirmed once at import and downgraded to /736x/ when originals is absent.
 * HEAD only, bounded concurrency; nothing is downloaded.
 */
async function resolveHdUrls(pins: ParsedPin[]): Promise<void> {
  const CONCURRENCY = 8
  let cursor = 0

  async function worker() {
    while (cursor < pins.length) {
      const pin = pins[cursor++]
      const ok = await fetch(pin.imageUrlHd, { method: 'HEAD' })
        .then(r => r.ok)
        .catch(() => false)
      if (!ok) pin.imageUrlHd = pin.imageUrl.replace(/\/(?:\d+x|originals)\//, `/${FALLBACK_SIZE}/`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pins.length) }, worker))
}

/**
 * Reads both surfaces and merges them. RSS entries win on collision so titles
 * and pin links survive; page-only pins fill in behind them.
 *
 * Throws only when both surfaces come back empty — one of them failing is
 * normal (private boards have no RSS, very new boards have a thin page).
 */
export async function fetchBoard(ref: ParsedBoardRef): Promise<FetchedBoard> {
  const rssUrl = `https://www.pinterest.com/${ref.owner}/${ref.slug}.rss`
  const [rssRes, pageRes] = await Promise.all([getText(rssUrl), getText(ref.boardUrl)])
  const rss = rssRes.text
  const html = pageRes.text

  // Counted before filtering so an empty result can be told apart from a
  // filter that ate everything.
  const rawImageRefs = html ? (html.match(/i\.pinimg\.com\/[^"'\s)]+/gi) ?? []).length : 0
  const pagePins = html ? parseBoardPagePins(html) : []
  const uniqueImages = html ? countContentImages(html) : 0

  const diagnostics: BoardDiagnostics = {
    rssStatus: rssRes.status,
    pageStatus: pageRes.status,
    pageBytes: html?.length ?? 0,
    rawImageRefs,
    uniqueImages,
    droppedAsChrome: Math.max(0, uniqueImages - pagePins.length),
    rssItems: rss ? (rss.match(/<item>/g) ?? []).length : 0,
  }

  if (!rss && !html) {
    throw new PinterestError(
      `Could not reach that board (page ${pageRes.status}, rss ${rssRes.status}).`,
    )
  }

  const byKey = new Map<string, ParsedPin>()
  for (const p of pagePins) byKey.set(p.pinKey, p)
  if (rss) {
    for (const p of parseRssPins(rss)) {
      // Same pin can arrive under an image-hash key from the page and a numeric
      // pin id from RSS; drop the page copy so it is not stored twice.
      const dupe = [...byKey.values()].find(v => imageHashKey(v.imageUrl) === imageHashKey(p.imageUrl))
      if (dupe) byKey.delete(dupe.pinKey)
      byKey.set(p.pinKey, p)
    }
  }

  const pins = [...byKey.values()]
  await resolveHdUrls(pins)

  const title = rss?.match(/<title>([\s\S]*?)<\/title>/)?.[1]
  return {
    title: title ? decodeEntities(title).trim() || null : null,
    pins,
    diagnostics,
  }
}

/** Distinct content-sized images in the page, before the chrome filter. */
function countContentImages(html: string): number {
  const re = /https:\/\/i\.pinimg\.com\/(?:\d+x|originals)\/[a-z0-9/]+\.(?:jpg|jpeg|png|webp)/gi
  const keys = new Set<string>()
  for (const url of html.match(re) ?? []) {
    const k = imageHashKey(url)
    if (k) keys.add(k)
  }
  return keys.size
}
