const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'apify~instagram-reel-scraper'
const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 48 // 4 min cap

const RAPIDAPI_HOST = 'instagram-reels-downloader-api.p.rapidapi.com'
const RAPIDAPI_SCRAPER_HOST = 'instagram-scraper-ai1.p.rapidapi.com'
/** The PRO plan rejects bursts, so space out the two calls a lookup needs. */
const RAPIDAPI_CALL_GAP_MS = 1_500

export interface BulkReelItem {
  id: string
  permalink: string
  videoUrl: string
  thumbnailUrl: string | null
  views: number
  likes: number
  comments: number
  postedAt: string | null
  source: 'apify' | 'rapidapi'
}

// ─── Apify — lists reels for a username ─────────────────────────

export interface ApifyReel {
  shortCode?: string
  url?: string
  displayUrl?: string
  images?: string[]
  videoUrl?: string
  videoViewCount?: number
  videoPlayCount?: number
  playCount?: number
  likesCount?: number
  commentsCount?: number
  timestamp?: string
}

export async function runApifyActorForUser(username: string, resultsLimit: number): Promise<ApifyReel[]> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: [username], resultsLimit }),
    }
  )
  const startData = await startRes.json()
  const runId: string = startData?.data?.id
  if (!runId) throw new Error('Apify run failed to start: ' + JSON.stringify(startData))

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)
    const statusData = await statusRes.json()
    const status: string = statusData?.data?.status
    if (status === 'SUCCEEDED') break
    if (status === 'FAILED' || status === 'ABORTED') throw new Error('Apify run failed: ' + status)
  }

  const dataRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json`
  )
  return dataRes.json()
}

// ─── RapidAPI — lists reels for a username (Apify fallback) ─────────

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

async function callScraperApi(path: string, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${RAPIDAPI_SCRAPER_HOST}${path}`, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': RAPIDAPI_SCRAPER_HOST,
    },
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok) {
    throw new Error((data?.message as string) ?? `RapidAPI request failed (HTTP ${res.status})`)
  }
  // This provider answers 200 with { status: 'fail' } rather than an error code.
  if (data?.status === 'fail') {
    throw new Error((data.message as string) ?? 'RapidAPI rejected the request')
  }
  if (!data) throw new Error('Empty response from RapidAPI')
  return data
}

export interface IgProfileInfo {
  userId: string
  followers: number
  isPrivate: boolean
}

/** The reels endpoint is keyed by numeric id, so a username has to be resolved first. */
export async function resolveIgProfile(username: string, apiKey: string): Promise<IgProfileInfo> {
  const data = await callScraperApi(
    `/user/info_v2/?username=${encodeURIComponent(username)}`,
    apiKey,
  )
  const user = ((data.data as Record<string, unknown>)?.user ?? data.user) as Record<string, unknown> | undefined
  const userId = pick(user ?? {}, 'pk', 'id', 'pk_id')
  if (!userId) throw new Error(`Could not resolve Instagram id for @${username}`)

  return {
    userId: String(userId),
    followers: Number(pick(user ?? {}, 'follower_count') ?? 0) || 1,
    isPrivate: Boolean(user?.is_private),
  }
}

/** Maps one RapidAPI reel record onto the Apify shape the scan pipeline expects. */
function rapidReelToApifyShape(raw: Record<string, unknown>): ApifyReel | null {
  const item = (raw.data ?? raw.media ?? raw) as Record<string, unknown>

  const shortCode = pick(item, 'code', 'shortcode') as string | undefined
  if (!shortCode) return null

  const thumbnails = (item.image_versions2 as Record<string, unknown> | undefined)?.candidates
  const thumbnail = Array.isArray(thumbnails) && thumbnails.length
    ? (thumbnails[0] as Record<string, unknown>).url as string | undefined
    : pick(item, 'thumbnail_url', 'display_url') as string | undefined

  const videoVersions = item.video_versions
  const videoUrl = Array.isArray(videoVersions) && videoVersions.length
    ? (videoVersions[0] as Record<string, unknown>).url as string | undefined
    : pick(item, 'video_url') as string | undefined

  // This provider prefixes some scalar fields with a type marker, e.g. '1ltaken_at'.
  const takenAt = Number(pick(item, 'taken_at', '1ltaken_at', 'taken_at_timestamp') ?? 0)

  return {
    shortCode,
    url: `https://www.instagram.com/reel/${shortCode}/`,
    displayUrl: thumbnail,
    videoUrl,
    videoViewCount: Number(pick(item, 'play_count', 'view_count', 'video_view_count') ?? 0),
    likesCount: Number(pick(item, 'like_count') ?? 0),
    commentsCount: Number(pick(item, 'comment_count') ?? 0),
    timestamp: takenAt > 0 ? new Date(takenAt * 1000).toISOString() : undefined,
  }
}

function postedAtMs(reel: ApifyReel): number {
  return reel.timestamp ? Date.parse(reel.timestamp) : 0
}

export async function listReelsViaRapidApi(
  username: string,
  apiKey: string,
  amount: number,
): Promise<{ reels: ApifyReel[]; followers: number }> {
  const profile = await resolveIgProfile(username, apiKey)
  if (profile.isPrivate) throw new Error(`@${username} is private — cannot scan it`)

  await new Promise(r => setTimeout(r, RAPIDAPI_CALL_GAP_MS))

  const data = await callScraperApi(
    `/user/reels_videos_v2/?user_id=${encodeURIComponent(profile.userId)}`,
    apiKey,
  )
  const raw = (data.items ?? data.reels ?? []) as unknown[]

  const reels = raw
    .map(r => rapidReelToApifyShape(r as Record<string, unknown>))
    .filter((r): r is ApifyReel => r !== null)
    // Pinned posts come back before the chronological run, so order explicitly.
    .sort((a, b) => postedAtMs(b) - postedAtMs(a))
    .slice(0, amount)

  return { reels, followers: profile.followers }
}

export interface ProfileReelsResult {
  reels: ApifyReel[]
  source: 'apify' | 'rapidapi'
  /** Only the RapidAPI path reports this; Apify callers resolve followers separately. */
  followers: number | null
}

/**
 * Lists reels for a profile, preferring Apify and falling back to RapidAPI when it is
 * unavailable — most often because the Apify account hit its usage limit.
 */
export async function listProfileReels(
  username: string,
  resultsLimit: number,
  rapidApiKey: string | null,
): Promise<ProfileReelsResult> {
  if (APIFY_TOKEN) {
    try {
      const reels = await runApifyActorForUser(username, resultsLimit)
      if (reels.length) return { reels, source: 'apify', followers: null }
      console.warn('[instagram-scrape] Apify returned no reels for', username, '— trying RapidAPI')
    } catch (err) {
      console.warn(
        '[instagram-scrape] Apify unavailable, falling back to RapidAPI:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  if (!rapidApiKey) {
    throw new Error(
      'Could not list reels: Apify is unavailable and no RapidAPI key is set. Add one in Settings.',
    )
  }

  const { reels, followers } = await listReelsViaRapidApi(username, rapidApiKey, resultsLimit)
  return { reels, source: 'rapidapi', followers }
}

// ─── RapidAPI — resolves a direct video link from a reel permalink ──

interface RapidDownloadMedia {
  url?: string
  type?: string
}
interface RapidDownloadData {
  thumbnail?: string
  like_count?: number
  view_count?: number | null
  medias?: RapidDownloadMedia[]
}

export async function resolveVideoUrlViaRapidApi(permalink: string, apiKey: string) {
  const res = await fetch(`https://${RAPIDAPI_HOST}/download?url=${encodeURIComponent(permalink)}`, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  })
  const json = await res.json().catch(() => null) as { success?: boolean; message?: string; data?: RapidDownloadData } | null
  if (!res.ok || json?.success === false) {
    throw new Error(json?.message ?? `HTTP ${res.status}`)
  }
  const data = json?.data
  if (!data) throw new Error('Empty response')
  const video = data.medias?.find(m => m.type === 'video' && m.url)
  if (!video?.url) throw new Error('No video media in the response (probably not a reel)')
  return {
    videoUrl: video.url,
    thumbnail: data.thumbnail ?? null,
    likes: data.like_count ?? null,
    views: data.view_count ?? null,
  }
}
