/**
 * Paste reel URLs → resolve to playable video URLs → enqueue for Copy-Paste.
 *
 * Lifted out of /api/monitor/enqueue-urls so the Telegram bot can run the same
 * path. That route authenticates with a session, which a webhook does not have,
 * so the caller passes the user id instead and the route stays a thin wrapper.
 */
import { one, query } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import { listProfileReels, resolveVideoUrlViaRapidApi } from '@/lib/instagram-scrape'
import { enqueueDiscoveryReels, type EnqueueReelInput } from './enqueue'
import { parseReelUrlList } from './parse-reel-url'
import { scheduleAutoClassify, scheduleClassifyOnly } from './auto-classify'
import { isPlayableVideoUrl } from './video-url'

export const MAX_URLS = 30
const LIST_LIMIT = 50

/**
 * Label for reels whose owner the pasted URL does not reveal (a bare
 * instagram.com/reel/<code> link). It names the card and the Drive folder, so it
 * must never be guessed from tracked_profiles: identity comes from the uploaded
 * reference photo, and borrowing an unrelated persona filed output under the
 * wrong character.
 */
export const UNKNOWN_SOURCE_LABEL = 'copy-paste'

export interface ResolveError {
  permalink: string
  error: string
}

export class EnqueueUrlsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: {
      resolveErrors?: ResolveError[]
      invalid?: string[]
      apifyDown?: boolean
    },
  ) {
    super(message)
  }
}

export interface EnqueueUrlsResult {
  ids: string[]
  enqueued: number
  resolved: number
  resolveErrors: ResolveError[]
  invalid: string[]
  sourceUsername: string | null
  characterProfile: string
  truncated: boolean
}

export async function enqueueReelUrlsForUser(opts: {
  userId: string
  /** Newline/whitespace separated reel links. */
  rawText: string
  username?: string | null
  sourceUsername?: string | null
  referenceImageUrl?: string | null
  /**
   * Queue the replication once analysis finishes. The dashboard leaves this
   * to the Replicate button; a caller with no UI has to ask for it.
   */
  autoReplicate?: boolean
  onReplicateQueued?: (r: { jobId: string | null; classified: number; failed: number }) => Promise<void>
}): Promise<EnqueueUrlsResult> {
  const { userId, rawText } = opts

  const { parsed, invalid } = parseReelUrlList(rawText, MAX_URLS)
  if (!parsed.length) {
    throw new EnqueueUrlsError(
      invalid.length ? 'No valid Instagram reel links' : 'Paste at least one Instagram reel URL',
      400,
      { invalid },
    )
  }

  const explicitUsername = String(opts.username ?? '').trim().replace(/^@/, '')
  const fromUrls = parsed.map(p => p.ownerUsername).find(Boolean) ?? null
  const username = explicitUsername || fromUrls || UNKNOWN_SOURCE_LABEL

  // Null when nobody told us the real owner. Only a real handle can be listed on
  // Instagram, so the fallback label must not leak into a scrape call.
  const sourceUsername =
    String(opts.sourceUsername ?? '').trim().replace(/^@/, '') || fromUrls || null
  const referenceImageUrl = String(opts.referenceImageUrl ?? '').trim() || null

  const resolved = new Map<string, EnqueueReelInput>()
  const resolveErrors: ResolveError[] = []
  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY')

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

  // 2) Download API — best path for a single pasted URL
  let missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
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

  // 3) Profile listing fallback — needs a real owner handle
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
      /* reported as resolveErrors below */
    }
  }

  for (const p of parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))) {
    resolveErrors.push({
      permalink: p.permalink,
      error: 'no playable video URL from download API or profile listing',
    })
  }

  const reels = [...resolved.values()]
  if (!reels.length) {
    // Prefer a concrete reason over a vague "try again" — usually RapidAPI
    // download outage + Apify quota + age-gated profile with empty listing.
    const apifyDown = !process.env.APIFY_API_KEY
    const detail = !rapidApiKey
      ? 'No RapidAPI key configured in Settings.'
      : quotaExhausted
        // Named exactly, because the fix is a plan upgrade and no amount of
        // retrying or picking a different reel will help.
        ? 'Your RapidAPI plan is out of requests for this month (HTTP 429). Upgrade the plan or wait for the quota to reset — retrying will keep failing until then.'
        : 'The Instagram download service rejected this reel, and we could not list it from the source profile either (age-restricted accounts often return 0 reels).'
    throw new EnqueueUrlsError(`Could not fetch that reel. ${detail}`, 502, {
      resolveErrors,
      invalid,
      apifyDown,
    })
  }

  for (const reel of reels) {
    try {
      await query(
        `INSERT INTO ig_downloader_reels
           (user_id, username, shortcode, permalink, video_url, thumbnail_url, views, likes, comments, posted_at, source, scraped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'rapidapi', now())
         ON CONFLICT (user_id, shortcode) DO UPDATE SET
           video_url = COALESCE(EXCLUDED.video_url, ig_downloader_reels.video_url),
           thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, ig_downloader_reels.thumbnail_url),
           scraped_at = now()`,
        [
          userId,
          sourceUsername ?? username, // column is NOT NULL — fall back to the label
          reel.id,
          reel.permalink,
          reel.videoUrl ?? null,
          reel.thumbnailUrl ?? null,
          reel.views ?? 0,
          reel.likes ?? 0,
          reel.comments ?? 0,
          reel.postedAt ?? null,
        ],
      )
    } catch {
      /* cache write is best-effort */
    }
  }

  const result = await enqueueDiscoveryReels(userId, username, reels, { referenceImageUrl })
  if (opts.autoReplicate) {
    scheduleAutoClassify(userId, result.ids, {
      thenReplicate: true,
      onQueued: opts.onReplicateQueued,
    })
  } else {
    scheduleClassifyOnly(userId, result.ids)
  }

  return {
    ids: result.ids,
    enqueued: result.ids.length,
    resolved: reels.length,
    resolveErrors,
    invalid,
    sourceUsername,
    characterProfile: username,
    truncated: parseReelUrlList(rawText, MAX_URLS + 1).parsed.length > MAX_URLS,
  }
}
