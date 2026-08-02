import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import { listProfileReels, resolveVideoUrlViaRapidApi } from '@/lib/instagram-scrape'
import { enqueueDiscoveryReels, type EnqueueReelInput } from '@/lib/monitor/enqueue'
import { parseReelUrlList } from '@/lib/monitor/parse-reel-url'
import { scheduleAutoClassify } from '@/lib/monitor/auto-classify'
import { isPlayableVideoUrl } from '@/lib/monitor/video-url'

const MAX_URLS = 30
const LIST_LIMIT = 50

/** Most recently tracked active Instagram profile — just a grouping label now, no character required. */
async function resolveDefaultProfile(userId: string): Promise<string | null> {
  const row = await one<{ username: string }>(
    `SELECT username FROM tracked_profiles
      WHERE user_id = $1 AND platform = 'Instagram' AND status = 'ACTIVE'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  )
  return row?.username ?? null
}

/**
 * Paste reel URLs → resolve (cache → download → profile list) → enqueue → auto-classify.
 * No character/profile binding is required — Copy-Paste v2 uses a per-batch reference photo.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    username?: string
    sourceUsername?: string
    urls?: string | string[]
    text?: string
    referenceImageUrl?: string
  }

  const rawText = Array.isArray(body.urls)
    ? body.urls.join('\n')
    : String(body.urls ?? body.text ?? '')

  const { parsed, invalid } = parseReelUrlList(rawText, MAX_URLS)
  if (!parsed.length) {
    return NextResponse.json(
      {
        error: invalid.length
          ? `No valid Instagram reel links`
          : 'Paste at least one Instagram reel URL',
        invalid,
      },
      { status: 400 },
    )
  }

  const explicitUsername = String(body.username ?? '').trim().replace(/^@/, '')
  const fromUrls = parsed.map(p => p.ownerUsername).find(Boolean) ?? null
  const defaultProfile = await resolveDefaultProfile(user.id)
  const username = explicitUsername || fromUrls || defaultProfile || 'copy-paste'

  const sourceUsername = (
    String(body.sourceUsername ?? '').trim().replace(/^@/, '')
    || fromUrls
    || username
  )
  const referenceImageUrl = String(body.referenceImageUrl ?? '').trim() || null

  const resolved = new Map<string, EnqueueReelInput>()
  const resolveErrors: Array<{ permalink: string; error: string }> = []
  const rapidApiKey = await resolveKey(user.id, 'RAPIDAPI_KEY')

  // 1) DB cache
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
      [user.id, p.shortCode],
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
      [user.id, p.shortCode],
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

  // 2) Download API (best path for a single pasted URL)
  let missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
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
      } catch {
        /* try listing next */
      }
    }
  }

  // 3) Profile listing fallback (Discovery Scan path)
  missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  if (missing.length && (process.env.APIFY_API_KEY || rapidApiKey)) {
    try {
      const { reels } = await listProfileReels(sourceUsername, LIST_LIMIT, rapidApiKey)
      const listedByCode = new Map(
        reels
          .filter(r => r.shortCode)
          .map(r => [r.shortCode!.toLowerCase(), r]),
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
      /* final error below */
    }
  }

  missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  for (const p of missing) {
    resolveErrors.push({
      permalink: p.permalink,
      error: 'no playable video URL from download API or profile listing',
    })
  }

  const reels = [...resolved.values()]
  if (!reels.length) {
    // Prefer a concrete reason over a vague "try again" — usually RapidAPI download
    // outage + Apify quota + age-gated profile with empty reel listing.
    const apifyDown = !process.env.APIFY_API_KEY
    const detail = !rapidApiKey
      ? 'No RapidAPI key configured in Settings.'
      : 'Instagram download service is down / upgrading, and we could not list this reel from the source profile (often age-restricted accounts return 0 reels). Apify is also over quota.'
    return NextResponse.json(
      {
        error: `Could not fetch that reel. ${detail}`,
        resolveErrors,
        invalid,
        apifyDown,
      },
      { status: 502 },
    )
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
          user.id,
          sourceUsername,
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
      /* ignore */
    }
  }

  try {
    const result = await enqueueDiscoveryReels(user.id, username, reels, { referenceImageUrl })
    scheduleAutoClassify(user.id, result.ids)
    return NextResponse.json({
      ok: true,
      ...result,
      classifying: true,
      resolved: reels.length,
      resolveErrors,
      invalid,
      sourceUsername,
      characterProfile: username,
      truncated: parseReelUrlList(rawText, MAX_URLS + 1).parsed.length > MAX_URLS,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Enqueue failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
