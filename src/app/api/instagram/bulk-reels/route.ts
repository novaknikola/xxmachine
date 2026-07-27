import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { resolveKey } from '@/lib/user-keys'
import { one, query, rows } from '@/lib/db'
import {
  listProfileReels, resolveVideoUrlViaRapidApi,
  type ApifyReel, type BulkReelItem,
} from '@/lib/instagram-scrape'

export type { BulkReelItem } from '@/lib/instagram-scrape'

const ENRICH_CONCURRENCY = 4
const CACHE_TTL_HOURS = 12

interface CachedProfileRow {
  last_scanned_at: string
}

interface CachedReelRow {
  shortcode: string
  permalink: string
  video_url: string
  thumbnail_url: string | null
  views: string | number
  likes: string | number
  comments: string | number
  posted_at: string | null
  source: 'apify' | 'rapidapi'
}

function rowToItem(r: CachedReelRow): BulkReelItem {
  return {
    id: r.shortcode,
    permalink: r.permalink,
    videoUrl: r.video_url,
    thumbnailUrl: r.thumbnail_url,
    views: Number(r.views),
    likes: Number(r.likes),
    comments: Number(r.comments),
    postedAt: r.posted_at,
    source: r.source,
  }
}

async function loadCachedReels(userId: string, username: string): Promise<BulkReelItem[]> {
  const cachedRows = await rows<CachedReelRow>(
    `select shortcode, permalink, video_url, thumbnail_url, views, likes, comments, posted_at, source
       from ig_downloader_reels where user_id = $1 and username = $2
      order by posted_at desc nulls last, scraped_at desc`,
    [userId, username],
  )
  return cachedRows.map(rowToItem)
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { username, amount, force, cacheOnly } = await req.json().catch(() => ({})) as {
    username?: string
    amount?: number
    force?: boolean
    /** History "View": return DB cache only — never call Apify/RapidAPI. */
    cacheOnly?: boolean
  }
  if (!username?.trim()) return NextResponse.json({ error: 'username required' }, { status: 400 })

  const target = Math.min(Math.max(amount ?? 24, 1), 200)
  const cleanUsername = username.trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
  if (!cleanUsername) return NextResponse.json({ error: 'username required' }, { status: 400 })

  const rapidApiKey = await resolveKey(user.id, 'RAPIDAPI_KEY')
  if (!process.env.APIFY_API_KEY && !rapidApiKey) {
    return NextResponse.json({
      error: 'No reel lister available — configure APIFY_API_KEY or add a RapidAPI key in Settings.',
    }, { status: 500 })
  }

  // ── Serve from cache ──
  // View/history (cacheOnly): any cached rows, ignore TTL and amount threshold.
  // Normal Search: fresh cache (<12h) only if it already has ≥ requested amount.
  {
    const profile = await one<CachedProfileRow>(
      `select last_scanned_at from ig_downloader_profiles where user_id = $1 and username = $2`,
      [user.id, cleanUsername],
    )
    if (profile && !force) {
      const ageHours = (Date.now() - new Date(profile.last_scanned_at).getTime()) / 3_600_000
      const reels = await loadCachedReels(user.id, cleanUsername)
      if (reels.length > 0) {
        if (cacheOnly) {
          return NextResponse.json({
            ok: true,
            username: cleanUsername,
            reels: reels.slice(0, target),
            skipped: [],
            fromCache: true,
            scannedAt: profile.last_scanned_at,
          })
        }
        if (ageHours < CACHE_TTL_HOURS && reels.length >= target) {
          return NextResponse.json({
            ok: true, username: cleanUsername, reels: reels.slice(0, target), skipped: [],
            fromCache: true, scannedAt: profile.last_scanned_at,
          })
        }
      }
    }
    if (cacheOnly) {
      return NextResponse.json({
        error: `No cached reels for @${cleanUsername}. Use Search (or Force rescan) once to populate the cache.`,
        fromCache: false,
      }, { status: 404 })
    }
  }

  // ── Fresh scan: Apify first, RapidAPI list fallback (same as Discovery) ──
  let listedReels: ApifyReel[]
  let listSource: 'apify' | 'rapidapi'
  try {
    const listed = await listProfileReels(cleanUsername, target, rapidApiKey)
    listedReels = listed.reels
    listSource = listed.source
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list reels' },
      { status: 500 },
    )
  }

  if (listedReels.length === 0) {
    return NextResponse.json({
      error: `No reels found for @${cleanUsername} via ${listSource} — check whether the account is private, has no Reels, or the username is correct.`,
    }, { status: 404 })
  }

  // Build the ordered work list, dedup by id, skip anything without a usable permalink
  const entries: { id: string; permalink: string; reel: ApifyReel }[] = []
  const seen = new Set<string>()
  for (const reel of listedReels) {
    const id = reel.shortCode ?? reel.url
    if (!id || seen.has(id)) continue
    const permalink = reel.url ?? (reel.shortCode ? `https://www.instagram.com/reel/${reel.shortCode}/` : null)
    if (!permalink) continue
    seen.add(id)
    entries.push({ id, permalink, reel })
  }

  const results: (BulkReelItem | null)[] = new Array(entries.length).fill(null)
  const skipped: { permalink: string; reason: string }[] = []
  const enrichQueue: number[] = []

  entries.forEach((entry, i) => {
    const { reel, id, permalink } = entry
    if (reel.videoUrl) {
      results[i] = {
        id,
        permalink,
        videoUrl: reel.videoUrl,
        thumbnailUrl: reel.displayUrl ?? reel.images?.[0] ?? null,
        views: reel.videoViewCount ?? reel.videoPlayCount ?? reel.playCount ?? 0,
        likes: reel.likesCount ?? 0,
        comments: reel.commentsCount ?? 0,
        postedAt: reel.timestamp ?? null,
        source: listSource,
      }
    } else if (rapidApiKey) {
      enrichQueue.push(i)
    } else {
      skipped.push({ permalink, reason: 'No video URL and no RapidAPI key for per-link resolve' })
    }
  })

  if (enrichQueue.length > 0 && rapidApiKey) {
    let qi = 0
    async function worker() {
      while (qi < enrichQueue.length) {
        const i = enrichQueue[qi++]
        const { reel, id, permalink } = entries[i]
        try {
          const enriched = await resolveVideoUrlViaRapidApi(permalink, rapidApiKey!)
          if (enriched) {
            results[i] = {
              id,
              permalink,
              videoUrl: enriched.videoUrl,
              thumbnailUrl: enriched.thumbnail ?? reel.displayUrl ?? null,
              views: enriched.views ?? reel.videoViewCount ?? reel.videoPlayCount ?? reel.playCount ?? 0,
              likes: enriched.likes ?? reel.likesCount ?? 0,
              comments: reel.commentsCount ?? 0,
              postedAt: reel.timestamp ?? null,
              source: 'rapidapi',
            }
          }
        } catch (err) {
          skipped.push({ permalink, reason: err instanceof Error ? err.message : 'unknown error' })
        }
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))
  }

  const freshReels = results.filter((r): r is BulkReelItem => r !== null).slice(0, target)

  if (freshReels.length === 0) {
    return NextResponse.json({
      error: rapidApiKey
        ? `Listed ${listedReels.length} posts via ${listSource}, but could not extract video links (they might be images, not reels).`
        : `Listed posts via ${listSource} without direct video links. Add a RapidAPI key in Settings for per-link extraction.`,
      skipped,
    }, { status: 404 })
  }

  // ── Persist: upsert reels + profile scan timestamp ──────────────
  for (const r of freshReels) {
    await query(
      `insert into ig_downloader_reels
         (user_id, username, shortcode, permalink, video_url, thumbnail_url, views, likes, comments, posted_at, source, scraped_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       on conflict (user_id, shortcode) do update set
         permalink = excluded.permalink, video_url = excluded.video_url, thumbnail_url = excluded.thumbnail_url,
         views = excluded.views, likes = excluded.likes, comments = excluded.comments,
         posted_at = excluded.posted_at, source = excluded.source, scraped_at = now()`,
      [user.id, cleanUsername, r.id, r.permalink, r.videoUrl, r.thumbnailUrl, r.views, r.likes, r.comments, r.postedAt, r.source],
    )
  }

  // Return the full accumulated library for this username, not just this scan's batch
  const reels = await loadCachedReels(user.id, cleanUsername)

  await query(
    `insert into ig_downloader_profiles (user_id, username, last_scanned_at, reels_found)
     values ($1, $2, now(), $3)
     on conflict (user_id, username) do update set
       last_scanned_at = now(), reels_found = excluded.reels_found`,
    [user.id, cleanUsername, reels.length],
  )

  return NextResponse.json({
    ok: true,
    username: cleanUsername,
    reels,
    skipped,
    fromCache: false,
    scannedAt: new Date().toISOString(),
    source: listSource,
  })
}
