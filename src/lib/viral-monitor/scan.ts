import { listProfileReels, fetchIgProfileViaApify } from '@/lib/instagram-scrape'
import { REELS_PER_PROFILE } from './config'
import type { ScannedVideo } from './types'

const RAPIDAPI_HOST = 'instagram-scraper-stable-api.p.rapidapi.com'

/**
 * Direct RapidAPI follower lookup — last-resort fallback when neither the
 * lister nor Apify's profile-details call could answer. Same one-off shape
 * as monitor/scan.ts's private fetchIgFollowers; duplicated rather than
 * imported since that module isn't meant to be a shared library and this
 * keeps viral-monitor dependency-free of it.
 */
async function fetchFollowersViaRapidApi(username: string, apiKey: string): Promise<number | null> {
  const res = await fetch(`https://${RAPIDAPI_HOST}/get_ig_user_info.php`, {
    method: 'POST',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': RAPIDAPI_HOST,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `username_or_url=${encodeURIComponent(username)}`,
  })
  const data = await res.json()
  const count = data?.result?.follower_count ?? data?.follower_count
  return typeof count === 'number' && count > 0 ? count : null
}

async function resolveFollowers(username: string, listedFollowers: number | null, rapidApiKey: string | null): Promise<number | null> {
  if (listedFollowers) return listedFollowers
  const viaApify = await fetchIgProfileViaApify(username).then(p => p?.followers ?? null).catch(() => null)
  if (viaApify) return viaApify
  if (rapidApiKey) return fetchFollowersViaRapidApi(username, rapidApiKey).catch(() => null)
  return null
}

/**
 * Lists the N most recent reels for a profile plus its follower count.
 * Reuses the same Apify-first/RapidAPI-fallback lister the Copy-Paste
 * monitor pipeline uses — no scraping code of its own.
 */
export async function scanProfile(username: string): Promise<ScannedVideo[]> {
  const rapidApiKey = process.env.RAPIDAPI_KEY ?? null
  const { reels, followers: listedFollowers } = await listProfileReels(username, REELS_PER_PROFILE, rapidApiKey)
  const followers = await resolveFollowers(username, listedFollowers, rapidApiKey)

  const seen = new Set<string>()
  const videos: ScannedVideo[] = []
  for (const reel of reels) {
    const shortcode = reel.shortCode
    const url = reel.url ?? (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null)
    if (!shortcode || !url || seen.has(shortcode)) continue
    seen.add(shortcode)
    videos.push({
      shortcode,
      url,
      views: reel.videoViewCount ?? reel.videoPlayCount ?? reel.playCount ?? 0,
      postedAt: reel.timestamp ?? null,
      profileUsername: username,
      followers,
    })
  }
  return videos
}
