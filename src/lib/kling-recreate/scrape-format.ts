import { isPlayableVideoUrl } from '../monitor/video-url'

export interface RecreateScrapeFailure {
  hasRapidApiKey: boolean
  hasApify: boolean
  apifyError: string | null
  quotaExhausted: boolean
}

/**
 * Short honest Telegram/job error. A missing RapidAPI key is not a
 * "not subscribed" plan failure — RapidAPI was never called.
 */
export function formatRecreateScrapeFailure(opts: RecreateScrapeFailure): string {
  if (!opts.hasRapidApiKey) {
    return opts.hasApify
      ? 'Could not fetch that reel — Apify returned no playable video, and this account has no RapidAPI key.'
      : 'Could not fetch that reel — no RapidAPI key for this account, and Apify is not configured.'
  }
  if (opts.quotaExhausted) {
    return 'Could not fetch that reel — RapidAPI is out of requests this month (HTTP 429).'
  }
  if (opts.apifyError) {
    const clipped = opts.apifyError.replace(/\s+/g, ' ').slice(0, 80)
    return `Could not fetch that reel — Apify failed (${clipped}).`
  }
  return 'Could not fetch that reel as a playable video.'
}

/** Pull a direct mp4 out of Instagram HTML. Page permalinks are rejected. */
export function extractPlayableVideoFromHtml(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/i,
    /"video_url"\s*:\s*"(https?:[^"]+)"/i,
    /"contentUrl"\s*:\s*"(https?:[^"]+)"/i,
  ]
  for (const re of patterns) {
    const match = html.match(re)
    if (!match?.[1]) continue
    const url = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    if (isPlayableVideoUrl(url)) return url
  }
  return null
}
