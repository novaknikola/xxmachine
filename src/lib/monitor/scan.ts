import { one, query } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import { runApifyActorForUser, resolveVideoUrlViaRapidApi, type ApifyReel } from '@/lib/instagram-scrape'
import { calculateViralityScore, calculateVelocity } from '@/lib/virality'
import type { TrackedProfileRow } from './types'

const ENRICH_CONCURRENCY = 3

export interface ScanResult {
  added: number
  newItemIds: string[]
  scanned: number
}

export async function scanTrackedProfile(
  userId: string,
  profile: TrackedProfileRow,
  options?: { resultsLimit?: number },
): Promise<ScanResult> {
  if (profile.platform !== 'Instagram') {
    throw new Error(`Platform ${profile.platform} not supported yet — use Instagram`)
  }

  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY')
  const limit = options?.resultsLimit ?? 12
  const apifyReels = await runApifyActorForUser(profile.username, limit)

  const followers = rapidApiKey
    ? await fetchIgFollowers(profile.username, rapidApiKey).catch(() => 1)
    : 1

  const cutoff = Date.now() - profile.max_age_days * 86_400_000
  const newItemIds: string[] = []
  let scanned = 0

  const entries: { contentId: string; url: string; reel: ApifyReel; permalink: string }[] = []
  const seen = new Set<string>()

  for (const reel of apifyReels) {
    const contentId = reel.shortCode ?? reel.url
    if (!contentId || seen.has(contentId)) continue
    const permalink = reel.url ?? (reel.shortCode ? `https://www.instagram.com/reel/${reel.shortCode}/` : null)
    if (!permalink) continue
    seen.add(contentId)
    entries.push({ contentId, url: permalink, reel, permalink })
  }

  // Resolve missing video URLs via RapidAPI
  const enriched = await enrichReels(entries, rapidApiKey)

  for (const row of enriched) {
    scanned++
    const postedAt = row.postedAt ? new Date(row.postedAt) : new Date()
    if (postedAt.getTime() < cutoff) continue

    const score = calculateViralityScore({
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      followers,
      postedAt,
    })
    if (score < profile.min_score) continue

    const inserted = await one<{ id: string }>(
      `INSERT INTO discovery_items
         (user_id, platform, profile, content_url, content_id,
          views, likes, comments, followers, score, velocity,
          thumbnail_url, video_url, posted_at, replicate_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id, content_id) DO NOTHING
       RETURNING id`,
      [
        userId,
        'Instagram',
        profile.username,
        row.url,
        row.contentId,
        row.views,
        row.likes,
        row.comments,
        followers,
        score,
        calculateVelocity(row.views, postedAt),
        row.thumbnailUrl,
        row.videoUrl,
        postedAt.toISOString(),
        profile.autopilot && score >= profile.autopilot_min_score ? 'pending_classify' : 'none',
      ],
    )

    if (inserted) {
      newItemIds.push(inserted.id)
      if (profile.autopilot && score >= profile.autopilot_min_score) {
        await query(
          `UPDATE discovery_items SET admin_status = 'APPROVED' WHERE id = $1`,
          [inserted.id],
        )
      }
    }
  }

  await query(
    `UPDATE tracked_profiles
        SET last_scanned_at = now(), reels_found = $3
      WHERE id = $1 AND user_id = $2`,
    [profile.id, userId, newItemIds.length],
  )

  return { added: newItemIds.length, newItemIds, scanned }
}

async function enrichReels(
  entries: { contentId: string; url: string; reel: ApifyReel; permalink: string }[],
  rapidApiKey: string | null,
): Promise<Array<{
  contentId: string
  url: string
  videoUrl: string | null
  thumbnailUrl: string | null
  views: number
  likes: number
  comments: number
  postedAt: string | null
}>> {
  const results: Array<{
    contentId: string
    url: string
    videoUrl: string | null
    thumbnailUrl: string | null
    views: number
    likes: number
    comments: number
    postedAt: string | null
  } | null> = new Array(entries.length).fill(null)

  const enrichQueue: number[] = []

  entries.forEach((entry, i) => {
    const { reel, contentId, url } = entry
    const views = reel.videoViewCount ?? reel.videoPlayCount ?? reel.playCount ?? 0
    if (reel.videoUrl) {
      results[i] = {
        contentId,
        url,
        videoUrl: reel.videoUrl,
        thumbnailUrl: reel.displayUrl ?? reel.images?.[0] ?? null,
        views,
        likes: reel.likesCount ?? 0,
        comments: reel.commentsCount ?? 0,
        postedAt: reel.timestamp ?? null,
      }
    } else if (rapidApiKey) {
      enrichQueue.push(i)
    } else {
      results[i] = {
        contentId,
        url,
        videoUrl: null,
        thumbnailUrl: reel.displayUrl ?? reel.images?.[0] ?? null,
        views,
        likes: reel.likesCount ?? 0,
        comments: reel.commentsCount ?? 0,
        postedAt: reel.timestamp ?? null,
      }
    }
  })

  if (enrichQueue.length > 0 && rapidApiKey) {
    let qi = 0
    async function worker() {
      while (qi < enrichQueue.length) {
        const i = enrichQueue[qi++]
        const { reel, contentId, url, permalink } = entries[i]
        try {
          const enriched = await resolveVideoUrlViaRapidApi(permalink, rapidApiKey!)
          if (enriched) {
            results[i] = {
              contentId,
              url,
              videoUrl: enriched.videoUrl,
              thumbnailUrl: enriched.thumbnail ?? reel.displayUrl ?? null,
              views: enriched.views ?? reel.videoViewCount ?? 0,
              likes: enriched.likes ?? reel.likesCount ?? 0,
              comments: reel.commentsCount ?? 0,
              postedAt: reel.timestamp ?? null,
            }
          }
        } catch {
          results[i] = {
            contentId,
            url,
            videoUrl: null,
            thumbnailUrl: reel.displayUrl ?? reel.images?.[0] ?? null,
            views: reel.videoViewCount ?? 0,
            likes: reel.likesCount ?? 0,
            comments: reel.commentsCount ?? 0,
            postedAt: reel.timestamp ?? null,
          }
        }
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))
  }

  return results.filter((r): r is NonNullable<typeof r> => r !== null)
}

async function fetchIgFollowers(username: string, apiKey: string): Promise<number> {
  const INSTAGRAM_HOST = 'instagram-scraper-stable-api.p.rapidapi.com'
  const res = await fetch(`https://${INSTAGRAM_HOST}/get_ig_user_info.php`, {
    method: 'POST',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': INSTAGRAM_HOST,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `username_or_url=${encodeURIComponent(username)}`,
  })
  const data = await res.json()
  return data?.result?.follower_count ?? data?.follower_count ?? 1
}
