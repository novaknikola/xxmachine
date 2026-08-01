import { one, query } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import { listProfileReels, resolveVideoUrlViaRapidApi, type ApifyReel } from '@/lib/instagram-scrape'
import { calculateViralityScore, calculateVelocity } from '@/lib/virality'
import { notifyViralPost } from '@/lib/monitor/notify'
import type { TrackedProfileRow } from './types'

const ENRICH_CONCURRENCY = 3
const VIRAL_VIEWS_THRESHOLD = Number(process.env.VIRAL_VIEWS_THRESHOLD ?? 100_000)
// Guard against alerting on a delta spanning a much longer gap than the ~23h scan cadence
// (e.g. a profile paused for days then reactivated) — that's not a "went viral in 24h" signal.
const VIRAL_CHECK_MAX_HOURS = 26

export interface ScanResult {
  added: number
  newItemIds: string[]
  scanned: number
  /** Reels returned by the lister before age/score/duplicate filters. */
  listed: number
  skippedAge: number
  skippedScore: number
  skippedDuplicate: number
  /** Which lister produced the reels, so a silent Apify outage is visible. */
  source: 'apify' | 'rapidapi'
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
  const {
    reels: apifyReels,
    source,
    followers: listedFollowers,
  } = await listProfileReels(profile.username, limit, rapidApiKey)

  // The lister already knows the follower count when it went through RapidAPI; only the
  // Apify path needs a separate lookup. Falling back to 1 would inflate every score.
  const followers = listedFollowers
    ?? (rapidApiKey ? await fetchIgFollowers(profile.username, rapidApiKey).catch(() => 1) : 1)

  const cutoff = Date.now() - profile.max_age_days * 86_400_000
  const newItemIds: string[] = []
  let scanned = 0
  let skippedAge = 0
  let skippedScore = 0
  let skippedDuplicate = 0

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
    if (postedAt.getTime() < cutoff) {
      skippedAge++
      continue
    }

    const score = calculateViralityScore({
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      followers,
      postedAt,
    })
    if (score < profile.min_score) {
      skippedScore++
      continue
    }

    const existing = await one<{
      id: string
      views_at_last_check: number | null
      checked_at: string | null
      viral_alerted_at: string | null
    }>(
      `SELECT id, views_at_last_check, checked_at, viral_alerted_at
         FROM discovery_items WHERE user_id = $1 AND content_id = $2`,
      [userId, row.contentId],
    )

    if (!existing) {
      const inserted = await one<{ id: string }>(
        `INSERT INTO discovery_items
           (user_id, platform, profile, content_url, content_id,
            views, likes, comments, followers, score, velocity,
            thumbnail_url, video_url, posted_at, replicate_status,
            views_at_last_check, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
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
          row.views,
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
      } else {
        skippedDuplicate++
      }
      continue
    }

    // Already tracked — re-check for a viral spike since the last scan, then refresh stats.
    if (existing.checked_at && existing.views_at_last_check != null) {
      const hoursSinceCheck = (Date.now() - new Date(existing.checked_at).getTime()) / 3_600_000
      const deltaViews = row.views - existing.views_at_last_check
      if (
        hoursSinceCheck <= VIRAL_CHECK_MAX_HOURS &&
        deltaViews >= VIRAL_VIEWS_THRESHOLD &&
        !existing.viral_alerted_at
      ) {
        await notifyViralPost(userId, profile.username, row.url, deltaViews).catch(() => {})
        await query(`UPDATE discovery_items SET viral_alerted_at = now() WHERE id = $1`, [existing.id])
      }
    }
    await query(
      `UPDATE discovery_items
          SET views = $3, likes = $4, comments = $5, score = $6, velocity = $7,
              views_at_last_check = $3, checked_at = now()
        WHERE id = $1 AND user_id = $2`,
      [existing.id, userId, row.views, row.likes, row.comments, score, calculateVelocity(row.views, postedAt)],
    )
    skippedDuplicate++
  }

  await query(
    `UPDATE tracked_profiles
        SET last_scanned_at = now(), reels_found = $3
      WHERE id = $1 AND user_id = $2`,
    [profile.id, userId, newItemIds.length],
  )

  return {
    added: newItemIds.length,
    newItemIds,
    scanned,
    listed: apifyReels.length,
    skippedAge,
    skippedScore,
    skippedDuplicate,
    source,
  }
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
