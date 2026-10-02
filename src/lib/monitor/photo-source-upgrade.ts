/**
 * Photo Replicator phase 2D — optional sharper source.
 *
 * The Clipper stores what the page showed: on a post page that is the full
 * photo, but a grid/explore tile or a later carousel slide can be a small or
 * cropped rendition. Before the first generation, a photo under
 * UPGRADE_MIN_SIDE is looked up by its post (Izvor, ?img_index=N kept):
 * Apify's anonymous actor first, then Intropix — the same two providers the
 * reel chain uses. A candidate is used only when it is provably the same
 * picture (perceptual match against the clipped photo, centre-cropped to its
 * aspect) and larger; it is re-hosted through the Phase 1 path (same host
 * allowlist and checks). Anything else keeps the Phase 1 photo and records why.
 * Never throws, never blocks the generation for longer than UPGRADE_TIMEOUT_MS.
 */
import sharp from 'sharp'
import { fetchPostsViaIntropix, resolveVideoUrlsViaApify, type ApifyReel, type IntropixPost } from '@/lib/instagram-scrape'
import { parseReelUrl } from './parse-reel-url'
import { rehostPhotoSource, type PhotoSource } from './photo-source'

export const UPGRADE_MIN_SIDE = 1000
export const UPGRADE_TIMEOUT_MS = 90_000
/** Mean absolute difference (0–255) of 32×32 greyscale thumbnails; same photo re-encoded/resized stays far below. */
export const SAME_PHOTO_MAX_MAD = 18

export function photoUpgradeEnabled(): boolean {
  return process.env.PHOTO_REPLICATOR_SOURCE_UPGRADE === 'true'
}

export interface UpgradeDeps {
  download(url: string): Promise<Buffer>
  apify(permalink: string): Promise<ApifyReel | null>
  intropix(permalink: string): Promise<IntropixPost | null>
  rehost(opts: { userId: string; imageUrl: string }): Promise<PhotoSource>
}

export const defaultUpgradeDeps: UpgradeDeps = {
  async download(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  },
  async apify(permalink) {
    const found = await resolveVideoUrlsViaApify([permalink])
    return [...found.values()][0] ?? null
  },
  async intropix(permalink) {
    return (await fetchPostsViaIntropix([permalink]))[0] ?? null
  },
  rehost: opts => rehostPhotoSource(opts),
}

export interface UpgradeOutcome {
  /** Our stored copy of the sharper photo; null = keep the Phase 1 photo. */
  url: string | null
  note: string
}

/** The post's shortcode and the slide (?img_index=N) from the Izvor link. */
export function postRef(sourceLink: string | null): { permalink: string; slide: number | null } | null {
  if (!sourceLink) return null
  const parsed = parseReelUrl(sourceLink, { allowBareShortcode: false })
  if (!parsed) return null
  let slide: number | null = null
  try {
    const raw = new URL(sourceLink).searchParams.get('img_index')
    if (raw && /^\d{1,2}$/.test(raw) && Number(raw) >= 1) slide = Number(raw)
  } catch { /* no slide */ }
  return { permalink: `https://www.instagram.com/p/${parsed.shortCode}/`, slide }
}

/** Photo URLs of a post, in slide order, as each provider reports them. */
export function apifyPhotoUrls(item: ApifyReel & { childPosts?: { type?: string; displayUrl?: string }[] }): string[] {
  if (item.type === 'Sidecar') {
    if (item.childPosts?.length) return item.childPosts.map(c => (c.type === 'Video' ? '' : c.displayUrl ?? ''))
    return item.images ?? []
  }
  if (item.type === 'Video') return []
  return item.displayUrl ? [item.displayUrl] : []
}

export function intropixPhotoUrls(post: IntropixPost): string[] {
  return (post.media ?? []).map(m => (m.media_type === 'image' ? m.media_url ?? '' : ''))
}

async function signature(buf: Buffer, aspect?: number): Promise<{ px: Buffer; w: number; h: number }> {
  const img = sharp(buf).rotate()
  const meta = await img.metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  let pipeline = sharp(buf).rotate()
  if (aspect && w && h) {
    // Centre crop of the candidate to the clipped photo's aspect: a grid tile is a centre crop of the post.
    const cw = Math.min(w, Math.round(h * aspect))
    const ch = Math.min(h, Math.round(w / aspect))
    pipeline = pipeline.extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch })
  }
  const px = await pipeline.resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer()
  return { px, w, h }
}

const mad = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length

/**
 * Decides once per job. Every failure path returns the reason and keeps the
 * Phase 1 photo; nothing here can fail the job.
 */
export async function upgradePhotoSource(
  job: { user_id: string; source_url: string; source_link: string | null },
  deps: UpgradeDeps = defaultUpgradeDeps,
): Promise<UpgradeOutcome> {
  const work = (async (): Promise<UpgradeOutcome> => {
    const original = await deps.download(job.source_url)
    const current = await signature(original)
    const minSide = Math.min(current.w, current.h)
    if (minSide >= UPGRADE_MIN_SIDE) return { url: null, note: `kept: Phase 1 photo is ${current.w}x${current.h}` }
    const ref = postRef(job.source_link)
    if (!ref) return { url: null, note: `kept ${current.w}x${current.h}: Izvor has no post link` }
    const aspect = current.w / current.h
    const currentSig = (await signature(original, aspect)).px

    const tried: string[] = []
    for (const provider of ['apify', 'intropix'] as const) {
      let urls: string[]
      try {
        if (provider === 'apify') {
          const item = await deps.apify(ref.permalink)
          urls = item && !item.error ? apifyPhotoUrls(item) : []
        } else {
          const post = await deps.intropix(ref.permalink)
          urls = post && !post.error ? intropixPhotoUrls(post) : []
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        tried.push(`${provider}: ${msg.slice(0, 80)}`)
        // One Apify account behind both actors: a spent plan is spent for Intropix too.
        if (/monthly usage hard limit|platform-feature-disabled/i.test(msg)) break
        continue
      }
      if (!urls.some(Boolean)) { tried.push(`${provider}: no photo`); continue }

      // The named slide first, then the others — the match decides, not the index.
      const order = urls.map((u, i) => ({ u, i })).filter(c => c.u)
      if (ref.slide) order.sort((a, b) => (a.i === ref.slide! - 1 ? -1 : b.i === ref.slide! - 1 ? 1 : a.i - b.i))
      let best: { url: string; slide: number; score: number; w: number; h: number } | null = null
      for (const c of order) {
        try {
          const sig = await signature(await deps.download(c.u), aspect)
          const score = mad(sig.px, currentSig)
          if (!best || score < best.score) best = { url: c.u, slide: c.i + 1, score, w: sig.w, h: sig.h }
          if (score <= SAME_PHOTO_MAX_MAD / 2) break
        } catch { /* unreadable candidate */ }
      }
      if (!best || best.score > SAME_PHOTO_MAX_MAD) { tried.push(`${provider}: no slide matches the clipped photo`); continue }
      if (Math.min(best.w, best.h) <= minSide) {
        return { url: null, note: `kept ${current.w}x${current.h}: ${provider} has the same photo only at ${best.w}x${best.h}` }
      }
      const stored = await deps.rehost({ userId: job.user_id, imageUrl: best.url })
      return {
        url: stored.url,
        note: `upgraded ${current.w}x${current.h} → ${stored.width}x${stored.height} via ${provider} (slide ${best.slide}, match ${best.score.toFixed(1)})`,
      }
    }
    return { url: null, note: `kept ${current.w}x${current.h}: ${tried.join('; ').slice(0, 300)}` }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<UpgradeOutcome>(resolve => {
    timer = setTimeout(() => resolve({ url: null, note: `kept: upgrade gave up after ${UPGRADE_TIMEOUT_MS / 1000}s` }), UPGRADE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work.catch(err => ({ url: null, note: `kept: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` })), timeout])
  } finally {
    clearTimeout(timer)
  }
}
