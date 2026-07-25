const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'apify~instagram-reel-scraper'
const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 48 // 4 min cap

const RAPIDAPI_HOST = 'instagram-reels-downloader-api.p.rapidapi.com'

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
