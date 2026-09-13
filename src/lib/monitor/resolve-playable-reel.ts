/**
 * Shared reel URL → playable mp4 resolve. Copy-Paste (enqueueReelUrlsForUser)
 * and Kling recreate (resolveRecreateVideoUrl) both call this so they cannot
 * drift onto different scrape stacks.
 *
 * Order is the Copy-Paste order, verified in enqueue-from-urls.ts:
 * 1) cache: discovery_items then ig_downloader_reels for this userId+shortcode
 * 2) resolveVideoUrlsViaApify(permalinks) when APIFY_API_KEY is set
 * 3) resolveVideoUrlViaRapidApi via resolveKey(userId, 'RAPIDAPI_KEY')
 *    — a missing key is skipped; we do not call RapidAPI with an empty key
 *      (that surfaces as a fake "not subscribed" plan error)
 * 4) listProfileReels(owner) when a real handle is known
 *
 * Copy-Paste had (1) and (4). Kling scrape.ts did not. Whether that is why
 * IGreplicator "always worked" is a hypothesis — this only equalizes the path.
 */
import { one } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import {
  listProfileReels,
  resolveVideoUrlViaRapidApi,
  resolveVideoUrlsViaApify,
} from '@/lib/instagram-scrape'
import { isPlayableVideoUrl } from './video-url'
import type { ParsedReelUrl } from './parse-reel-url'

const LIST_LIMIT = 50

export interface PlayableReel {
  id: string
  permalink: string
  videoUrl: string
  thumbnailUrl: string | null
  views: number
  likes: number
  comments?: number
  postedAt?: string | null
}

export interface PlayableReelResolveResult {
  resolved: Map<string, PlayableReel>
  apifyError: string | null
  quotaExhausted: boolean
  /** False when resolveKey returned null/empty — RapidAPI was not called. */
  hasRapidApiKey: boolean
}

export async function resolvePlayableReels(opts: {
  userId: string
  parsed: ParsedReelUrl[]
  sourceUsername?: string | null
}): Promise<PlayableReelResolveResult> {
  const { userId, parsed } = opts
  const sourceUsername = String(opts.sourceUsername ?? '').trim().replace(/^@/, '') || null
  const resolved = new Map<string, PlayableReel>()
  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY')
  const hasRapidApiKey = Boolean(rapidApiKey)

  // 1) Anything already downloaded for this user
  for (const p of parsed) {
    const cached = await one<{
      content_id: string
      content_url: string
      video_url: string | null
      thumbnail_url: string | null
      views: number
      likes: number
    }>(
      `SELECT content_id, content_url, video_url, thumbnail_url, views, likes
         FROM discovery_items
        WHERE user_id = $1 AND lower(content_id) = lower($2)
          AND video_url IS NOT NULL
        LIMIT 1`,
      [userId, p.shortCode],
    )
    if (cached?.video_url && isPlayableVideoUrl(cached.video_url)) {
      resolved.set(p.shortCode.toLowerCase(), {
        id: cached.content_id,
        permalink: cached.content_url || p.permalink,
        videoUrl: cached.video_url,
        thumbnailUrl: cached.thumbnail_url,
        views: cached.views,
        likes: cached.likes,
      })
      continue
    }

    const dl = await one<{
      shortcode: string
      permalink: string
      video_url: string
      thumbnail_url: string | null
      views: number
      likes: number
    }>(
      `SELECT shortcode, permalink, video_url, thumbnail_url, views, likes
         FROM ig_downloader_reels
        WHERE user_id = $1 AND lower(shortcode) = lower($2)
          AND video_url IS NOT NULL AND video_url <> ''
        LIMIT 1`,
      [userId, p.shortCode],
    )
    if (dl?.video_url && isPlayableVideoUrl(dl.video_url)) {
      resolved.set(p.shortCode.toLowerCase(), {
        id: dl.shortcode,
        permalink: dl.permalink || p.permalink,
        videoUrl: dl.video_url,
        thumbnailUrl: dl.thumbnail_url,
        views: dl.views,
        likes: dl.likes,
      })
    }
  }

  // 2) Apify by permalink — one run for the whole batch, and unlike the RapidAPI
  //    downloaders it is not metered per request, so it survives a spent plan.
  let missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  let apifyError: string | null = null
  if (missing.length && process.env.APIFY_API_KEY) {
    try {
      const byCode = await resolveVideoUrlsViaApify(missing.map(p => p.permalink))
      for (const p of missing) {
        const match = byCode.get(p.shortCode.toLowerCase())
        if (!match?.videoUrl || !isPlayableVideoUrl(match.videoUrl)) continue
        resolved.set(p.shortCode.toLowerCase(), {
          id: match.shortCode ?? p.shortCode,
          permalink: match.url ?? p.permalink,
          videoUrl: match.videoUrl,
          thumbnailUrl: match.displayUrl ?? match.images?.[0] ?? null,
          views: match.videoViewCount ?? match.videoPlayCount ?? 0,
          likes: match.likesCount ?? 0,
          comments: match.commentsCount ?? 0,
          postedAt: match.timestamp ?? null,
        })
      }
    } catch (err) {
      apifyError = err instanceof Error ? err.message : String(err)
      /* fall through to the RapidAPI downloaders */
    }
  }

  // 3) Download API — per-reel fallback when Apify could not see the post
  missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  // A spent RapidAPI plan looks exactly like a broken one from here: every call
  // fails. The failure message used to guess "service is down / upgrading",
  // which sent people looking at Instagram instead of at their own plan.
  let quotaExhausted = false
  if (missing.length && rapidApiKey) {
    for (const p of missing) {
      try {
        const r = await resolveVideoUrlViaRapidApi(p.permalink, rapidApiKey)
        if (!isPlayableVideoUrl(r.videoUrl)) continue
        resolved.set(p.shortCode.toLowerCase(), {
          id: p.shortCode,
          permalink: p.permalink,
          videoUrl: r.videoUrl,
          thumbnailUrl: r.thumbnail,
          views: r.views ?? 0,
          likes: r.likes ?? 0,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/\b429\b|exceeded the .*quota|too many requests/i.test(msg)) quotaExhausted = true
        /* fall through to the listing path */
      }
    }
  }

  // 4) Profile listing fallback — needs a real owner handle
  missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  if (missing.length && sourceUsername && (process.env.APIFY_API_KEY || rapidApiKey)) {
    try {
      const { reels } = await listProfileReels(sourceUsername, LIST_LIMIT, rapidApiKey)
      const listedByCode = new Map(
        reels.filter(r => r.shortCode).map(r => [r.shortCode!.toLowerCase(), r]),
      )
      for (const p of missing) {
        const match = listedByCode.get(p.shortCode.toLowerCase())
        if (!match?.videoUrl || !isPlayableVideoUrl(match.videoUrl)) continue
        resolved.set(p.shortCode.toLowerCase(), {
          id: match.shortCode ?? p.shortCode,
          permalink: match.url ?? p.permalink,
          videoUrl: match.videoUrl,
          thumbnailUrl: match.displayUrl ?? match.images?.[0] ?? null,
          views: match.videoViewCount ?? 0,
          likes: match.likesCount ?? 0,
          comments: match.commentsCount ?? 0,
          postedAt: match.timestamp ?? null,
        })
      }
    } catch {
      /* reported as resolveErrors by the caller */
    }
  }

  return { resolved, apifyError, quotaExhausted, hasRapidApiKey }
}

/** Single-reel wrapper — same userId / permalink / shortcode / RapidAPI lookup. */
export async function resolvePlayableReelVideo(opts: {
  userId: string
  permalink: string
  shortCode: string
  ownerUsername?: string | null
}): Promise<PlayableReelResolveResult & { reel: PlayableReel | null }> {
  const parsed: ParsedReelUrl = {
    shortCode: opts.shortCode,
    permalink: opts.permalink,
    ownerUsername: opts.ownerUsername ?? undefined,
  }
  const result = await resolvePlayableReels({
    userId: opts.userId,
    parsed: [parsed],
    sourceUsername: opts.ownerUsername ?? null,
  })
  return {
    ...result,
    reel: result.resolved.get(opts.shortCode.toLowerCase()) ?? null,
  }
}
