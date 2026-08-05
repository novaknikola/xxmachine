import { parseReelUrl } from '@/lib/monitor/parse-reel-url'

const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'apify~instagram-scraper'
const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 48 // 4 min cap

const RAPIDAPI_HOST = 'instagram-reels-downloader-api.p.rapidapi.com'
const RAPIDAPI_SCRAPER_HOST = 'instagram-scraper-ai1.p.rapidapi.com'
/** Fallback when the primary downloader host is upgrading / down. */
const RAPIDAPI_DOWNLOAD_FALLBACK_HOST =
  'instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com'
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
  /** Echo of the directUrls entry that produced this item. */
  inputUrl?: string
}

async function runApifyActor<T = ApifyReel>(input: object): Promise<T[]> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
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

export async function runApifyActorForUser(username: string, resultsLimit: number): Promise<ApifyReel[]> {
  // This actor is URL-driven, not username-driven; resultsType 'reels' is what
  // keeps grid photos and carousels out of the listing.
  return runApifyActor({
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: 'reels',
    resultsLimit,
  })
}

interface ApifyProfileDetails {
  username?: string
  followersCount?: number
  private?: boolean
}

/**
 * Profile follower count + privacy, via the same actor's 'details' mode.
 *
 * Virality scoring divides by this, so a wrong number is worse than none —
 * callers get null and are expected to refuse the scan rather than guess.
 */
export async function fetchIgProfileViaApify(
  username: string,
): Promise<{ followers: number; isPrivate: boolean } | null> {
  if (!APIFY_TOKEN) return null

  const items = await runApifyActor<ApifyProfileDetails>({
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: 'details',
    resultsLimit: 1,
  })
  const followers = items?.[0]?.followersCount
  if (typeof followers !== 'number' || followers <= 0) return null
  return { followers, isPrivate: items[0].private === true }
}

/**
 * Resolves direct video links for pasted reel permalinks, in ONE actor run for the
 * whole batch. The RapidAPI downloaders are per-reel and per-request metered, so on
 * a spent plan this is the only path that still answers — and even on a healthy plan
 * it is one call instead of N.
 *
 * Keyed by lowercased shortcode. Missing/non-video posts are simply absent.
 */
export async function resolveVideoUrlsViaApify(
  permalinks: string[],
): Promise<Map<string, ApifyReel>> {
  const out = new Map<string, ApifyReel>()
  if (!APIFY_TOKEN || !permalinks.length) return out

  // resultsLimit is per input URL here — a permalink is a single post either way.
  const items = await runApifyActor({
    directUrls: permalinks,
    resultsType: 'posts',
    resultsLimit: 1,
    addParentData: false,
  })

  for (const item of items ?? []) {
    // The actor echoes back what it was asked for, so a redirected or reshaped
    // canonical url still maps onto the shortcode the caller is waiting on.
    const code =
      item.shortCode
      ?? (item.url ? parseReelUrl(item.url)?.shortCode : undefined)
      ?? (item.inputUrl ? parseReelUrl(item.inputUrl)?.shortCode : undefined)
    if (code) out.set(code.toLowerCase(), item)
  }
  return out
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

async function resolveViaPrimaryDownloader(permalink: string, apiKey: string) {
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
  // Reject Instagram HTML page links masquerading as media (breaks ffmpeg probe).
  if (/instagram\.com\/(p|reel|reels|tv)\//i.test(video.url)) {
    throw new Error('Downloader returned a page URL instead of a video file')
  }
  return {
    videoUrl: video.url,
    thumbnail: data.thumbnail ?? null,
    likes: data.like_count ?? null,
    views: data.view_count ?? null,
  }
}

interface ScraperFallbackItem {
  media?: string
  thumb?: string
  isVideo?: boolean
}

async function resolveViaScraperFallback(permalink: string, apiKey: string) {
  const res = await fetch(
    `https://${RAPIDAPI_DOWNLOAD_FALLBACK_HOST}/scraper?url=${encodeURIComponent(permalink)}`,
    {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': RAPIDAPI_DOWNLOAD_FALLBACK_HOST,
        'Content-Type': 'application/json',
      },
    },
  )
  const json = await res.json().catch(() => null) as {
    data?: ScraperFallbackItem[]
    message?: string
    error?: string
  } | null
  if (!res.ok) {
    throw new Error(json?.message ?? json?.error ?? `HTTP ${res.status}`)
  }
  const items = Array.isArray(json?.data) ? json.data : []
  const video = items.find(m => m.isVideo && m.media)
  if (!video?.media) throw new Error('No video media in scraper fallback response')
  if (/instagram\.com\/(p|reel|reels|tv)\//i.test(video.media)) {
    throw new Error('Downloader returned a page URL instead of a video file')
  }
  return {
    videoUrl: video.media,
    thumbnail: video.thumb ?? null,
    likes: null as number | null,
    views: null as number | null,
  }
}

export async function resolveVideoUrlViaRapidApi(permalink: string, apiKey: string) {
  try {
    return await resolveViaPrimaryDownloader(permalink, apiKey)
  } catch (primaryErr) {
    await new Promise(r => setTimeout(r, RAPIDAPI_CALL_GAP_MS))
    try {
      return await resolveViaScraperFallback(permalink, apiKey)
    } catch (fallbackErr) {
      const primary = primaryErr instanceof Error ? primaryErr.message : 'primary failed'
      const fallback = fallbackErr instanceof Error ? fallbackErr.message : 'fallback failed'
      throw new Error(`${primary} (fallback: ${fallback})`)
    }
  }
}

export interface ResolvedReelMedia {
  videoUrl: string
  thumbnail: string | null
  likes: number | null
  views: number | null
  source: 'download' | 'profile_list'
}

/**
 * Resolve a reel video URL. Prefers the download API; when that host is down
 * (upgrade / outage), falls back to listing the owner's reels and matching shortcode.
 */
export async function resolveReelMedia(
  permalink: string,
  apiKey: string,
  opts?: { shortCode?: string; ownerUsername?: string | null },
): Promise<ResolvedReelMedia> {
  let downloadError: string | null = null
  try {
    const r = await resolveVideoUrlViaRapidApi(permalink, apiKey)
    return {
      videoUrl: r.videoUrl,
      thumbnail: r.thumbnail,
      likes: r.likes,
      views: r.views,
      source: 'download',
    }
  } catch (err) {
    downloadError = err instanceof Error ? err.message : 'Download API failed'
  }

  const owner = opts?.ownerUsername?.trim().replace(/^@/, '')
  const shortCode =
    opts?.shortCode
    ?? permalink.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i)?.[1]

  if (!owner || !shortCode) {
    throw new Error(
      `${downloadError}. Add the source IG username (reel owner) so we can resolve via profile listing.`,
    )
  }

  await new Promise(r => setTimeout(r, RAPIDAPI_CALL_GAP_MS))
  const { reels } = await listReelsViaRapidApi(owner, apiKey, 50)
  const match = reels.find(r => (r.shortCode ?? '').toLowerCase() === shortCode.toLowerCase())
  if (!match?.videoUrl) {
    throw new Error(
      `Download API: ${downloadError}. Profile @${owner} listed ${reels.length} reels but none matched ${shortCode}.`,
    )
  }

  return {
    videoUrl: match.videoUrl,
    thumbnail: match.displayUrl ?? match.images?.[0] ?? null,
    likes: match.likesCount ?? null,
    views: match.videoViewCount ?? null,
    source: 'profile_list',
  }
}
