import { parseReelUrl } from '@/lib/monitor/parse-reel-url'
import { isPlayableVideoUrl } from '@/lib/monitor/video-url'
import { resolveVideoUrlViaRapidApi, resolveVideoUrlsViaApify } from '@/lib/instagram-scrape'
import { resolveKey } from '@/lib/user-keys'

/**
 * Resolve a pasted Instagram reel permalink to a playable mp4 URL.
 * Same Apify-then-RapidAPI order as Copy-Paste, kept here so that pipeline
 * is not imported or modified.
 */
export async function resolveRecreateVideoUrl(userId: string, sourceUrl: string): Promise<string> {
  const parsed = parseReelUrl(sourceUrl)
  if (!parsed) throw new Error('Not a valid Instagram reel URL')

  if (process.env.APIFY_API_KEY) {
    try {
      const byCode = await resolveVideoUrlsViaApify([parsed.permalink])
      const match = byCode.get(parsed.shortCode.toLowerCase())
      if (match?.videoUrl && isPlayableVideoUrl(match.videoUrl)) return match.videoUrl
    } catch (err) {
      console.warn(
        '[kling-recreate] Apify resolve failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY').catch(() => '')
  if (rapidApiKey) {
    const r = await resolveVideoUrlViaRapidApi(parsed.permalink, rapidApiKey)
    if (isPlayableVideoUrl(r.videoUrl)) return r.videoUrl
  }

  throw new Error('Could not resolve a playable video URL from Apify or RapidAPI')
}
