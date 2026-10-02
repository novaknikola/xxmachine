/**
 * The Clipper's "→ Photo Replicator" target: re-host the clipped photo and add
 * it to the Photo Replicator tab. Phase 1 stops there — no generation, no
 * WaveSpeed, no farm. Only the owner may use it: the rows land in the owner's
 * spreadsheet.
 */
import { isOwnerEmail } from '@/lib/session'
import { listCharacters } from '@/lib/content-ops/characters'
import { parseReelUrl } from './parse-reel-url'
import { PhotoSourceError, rehostPhotoSource, type PhotoSource } from './photo-source'
import { addPhotoRow, type PhotoRowInput, type PhotoRowResult } from './photo-sheet'

export const PHOTO_REPLICATOR_TARGET = 'photo-replicator'

export interface PhotoClipBody {
  imageUrl?: unknown
  pageUrl?: unknown
  permalink?: unknown
}

export interface PhotoClipDeps {
  enabled(): boolean
  isOwner(email: string): boolean
  rehost(opts: { userId: string; imageUrl: string }): Promise<PhotoSource>
  /** The Karakter dropdown: the same characters the Viral Sheet offers. */
  characterNames(userId: string): Promise<string[]>
  addRow(input: PhotoRowInput, characterNames: string[]): Promise<PhotoRowResult>
  now(): Date
}

export const defaultPhotoClipDeps: PhotoClipDeps = {
  enabled: () => process.env.PHOTO_REPLICATOR_ENABLED === 'true',
  isOwner: isOwnerEmail,
  rehost: opts => rehostPhotoSource(opts),
  characterNames: async userId => (await listCharacters(userId)).filter(c => c.reference_image_url).map(c => c.name),
  addRow: (input, characterNames) => addPhotoRow(input, { characterNames }),
  now: () => new Date(),
}

const STATUS_BY_CODE: Record<PhotoSourceError['code'], number> = {
  INVALID_URL: 400,
  HOST_NOT_ALLOWED: 400,
  TOO_LARGE: 413,
  NOT_AN_IMAGE: 422,
  TOO_SMALL: 422,
  FETCH_FAILED: 502,
  STORAGE_FAILED: 502,
}

/** An Instagram carousel holds at most 20 slides. */
const MAX_CAROUSEL_SLIDE = 20

/** The carousel slide (?img_index=N) an Instagram URL names, when N is a real slide number. */
function slideIndex(raw: string): number | null {
  try {
    const s = raw.trim()
    const value = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).searchParams.get('img_index')
    if (!value || !/^\d{1,2}$/.test(value)) return null
    const n = Number(value)
    return n >= 1 && n <= MAX_CAROUSEL_SLIDE ? n : null
  } catch {
    return null
  }
}

/**
 * What the Izvor column shows: the post's permalink when the Clipper found one
 * (or the page is the post), otherwise the page without its query string.
 * The permalink keeps one thing from the query: ?img_index=N, the carousel
 * slide that was on screen, when Instagram put it there — in the link itself
 * or in the page URL of that same post.
 */
export function photoSourceLink(permalink: unknown, pageUrl: unknown): string {
  for (const raw of [permalink, pageUrl]) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const parsed = parseReelUrl(raw, { allowBareShortcode: false })
    if (!parsed) continue
    // /p/ opens photos and reels alike; the parser itself always writes /reel/.
    const link = `https://www.instagram.com/p/${parsed.shortCode}/`
    const page = typeof pageUrl === 'string' ? pageUrl : ''
    const samePost = parseReelUrl(page, { allowBareShortcode: false })?.shortCode === parsed.shortCode
    const slide = slideIndex(raw) ?? (samePost ? slideIndex(page) : null)
    return slide ? `${link}?img_index=${slide}` : link
  }
  if (typeof pageUrl !== 'string') return ''
  try {
    const url = new URL(pageUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return `${url.origin}${url.pathname}`.slice(0, 500)
  } catch {
    return ''
  }
}

export async function clipToPhotoReplicator(
  user: { id: string; email: string },
  body: PhotoClipBody,
  deps: PhotoClipDeps = defaultPhotoClipDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!deps.enabled()) {
    return { status: 403, body: { error: 'Photo Replicator nije uključen na serveru.' } }
  }
  if (!deps.isOwner(user.email)) {
    return { status: 403, body: { error: 'Photo Replicator je dostupan samo vlasniku naloga.' } }
  }
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
  if (!imageUrl) return { status: 400, body: { error: 'Nema linka slike.' } }

  let source: PhotoSource
  try {
    source = await deps.rehost({ userId: user.id, imageUrl })
  } catch (err) {
    if (err instanceof PhotoSourceError) {
      return { status: STATUS_BY_CODE[err.code], body: { error: err.message, code: err.code } }
    }
    throw err
  }

  try {
    const names = await deps.characterNames(user.id)
    const row = await deps.addRow(
      { imageUrl: source.url, source: photoSourceLink(body.permalink, body.pageUrl), addedAt: deps.now() },
      names,
    )
    return {
      status: 200,
      body: {
        ok: true,
        target: PHOTO_REPLICATOR_TARGET,
        rowNumber: row.rowNumber,
        alreadyInSheet: !row.appended,
        imageUrl: source.url,
        width: source.width,
        height: source.height,
        reusedStorage: source.reused,
      },
    }
  } catch (err) {
    console.error('[photo-replicator] sheet write failed:', err instanceof Error ? err.message : err)
    // The photo is stored either way; clipping again finds it and only retries the row.
    return { status: 502, body: { error: 'Slika je sačuvana, ali red u Sheet-u nije dodat — pokušaj ponovo.', code: 'SHEET_FAILED' } }
  }
}
