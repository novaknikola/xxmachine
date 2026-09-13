import { parseReelUrl } from '@/lib/monitor/parse-reel-url'
import { isPlayableVideoUrl } from '@/lib/monitor/video-url'
import {
  apifyRestriction,
  resolveVideoUrlViaPublicPage,
  resolveVideoUrlViaRapidApi,
  resolveVideoUrlViaStableApi,
  resolveVideoUrlsViaApify,
} from '@/lib/instagram-scrape'
import { composeRecreateScrapeError } from '@/lib/instagram-video-extract.mjs'
import { resolveVideoUrlViaYtdlp } from './ytdlp.mjs'
import { resolveKey } from '@/lib/user-keys'

export { composeRecreateScrapeError }

export interface RecreateScrapeNote {
  source: string
  detail: string
}

/**
 * Resolve a pasted Instagram reel permalink (or an already-hosted mp4) to a
 * playable mp4 URL. Apify → public page → RapidAPI → stable-api → yt-dlp
 * `--get-url`. Telegram file upload is last-resort only, not the product path.
 */
export async function resolveRecreateVideoUrl(userId: string, sourceUrl: string): Promise<string> {
  if (isPlayableVideoUrl(sourceUrl)) return sourceUrl.trim()

  const parsed = parseReelUrl(sourceUrl)
  if (!parsed) throw new Error('Not a valid Instagram reel URL')

  const notes: RecreateScrapeNote[] = []

  if (process.env.APIFY_API_KEY) {
    try {
      const byCode = await resolveVideoUrlsViaApify([parsed.permalink])
      const match = byCode.get(parsed.shortCode.toLowerCase())
      if (match?.videoUrl && isPlayableVideoUrl(match.videoUrl)) return match.videoUrl
      const restriction = apifyRestriction(match)
      if (restriction) notes.push({ source: 'Apify', detail: restriction })
      else if (match && !match.videoUrl) notes.push({ source: 'Apify', detail: 'item had no videoUrl' })
    } catch (err) {
      notes.push({ source: 'Apify', detail: err instanceof Error ? err.message : String(err) })
      console.warn('[kling-recreate] Apify resolve failed:', notes.at(-1)?.detail)
    }
  }

  try {
    const publicUrl = await resolveVideoUrlViaPublicPage(parsed.permalink)
    if (publicUrl && isPlayableVideoUrl(publicUrl)) return publicUrl
  } catch (err) {
    notes.push({
      source: 'public page',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY').catch(() => '')
  if (rapidApiKey) {
    try {
      const r = await resolveVideoUrlViaRapidApi(parsed.permalink, rapidApiKey)
      if (isPlayableVideoUrl(r.videoUrl)) return r.videoUrl
    } catch (err) {
      notes.push({
        source: 'RapidAPI downloader',
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const stable = await resolveVideoUrlViaStableApi(parsed.permalink, rapidApiKey)
      if (stable && isPlayableVideoUrl(stable)) return stable
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      notes.push({ source: 'RapidAPI stable-api', detail })
    }
  }

  try {
    const ytdlpUrl = await resolveVideoUrlViaYtdlp(parsed.permalink)
    if (ytdlpUrl && isPlayableVideoUrl(ytdlpUrl)) return ytdlpUrl
  } catch (err) {
    notes.push({
      source: 'yt-dlp',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  throw new Error(composeRecreateScrapeError(notes))
}
