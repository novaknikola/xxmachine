import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseReelUrl } from '@/lib/monitor/parse-reel-url'
import { isPlayableVideoUrl } from '@/lib/monitor/video-url'
import { resolvePlayableReelVideo } from '@/lib/monitor/resolve-playable-reel'
import { extractPlayableVideoFromHtml, formatRecreateScrapeFailure } from './scrape-format'

export { extractPlayableVideoFromHtml, formatRecreateScrapeFailure } from './scrape-format'
export type { RecreateScrapeFailure } from './scrape-format'

const execFileAsync = promisify(execFile)
const IG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': IG_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Kling-only extra after the shared Copy-Paste path. */
async function resolveViaPublicPage(permalink: string, shortCode: string): Promise<string | null> {
  const pages = [
    permalink,
    `https://www.instagram.com/p/${shortCode}/embed/captioned/`,
    `https://www.instagram.com/reel/${shortCode}/embed/captioned/`,
  ]
  for (const url of pages) {
    const html = await fetchHtml(url)
    if (!html) continue
    const video = extractPlayableVideoFromHtml(html)
    if (video) return video
  }
  return null
}

/** Kling-only extra after the shared Copy-Paste path. */
async function resolveViaYtDlp(permalink: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['-g', '--no-playlist', permalink], {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    })
    for (const line of stdout.split(/\r?\n/)) {
      const url = line.trim()
      if (isPlayableVideoUrl(url)) return url
    }
  } catch {
    /* binary missing or extractor failed */
  }
  return null
}

/**
 * Resolve a pasted Instagram reel permalink to a playable mp4 URL.
 * Shared Copy-Paste path first (cache → Apify → user RapidAPI → profile list),
 * then Kling-only public-page / yt-dlp extras.
 */
export async function resolveRecreateVideoUrl(userId: string, sourceUrl: string): Promise<string> {
  const parsed = parseReelUrl(sourceUrl)
  if (!parsed) throw new Error('Not a valid Instagram reel URL')

  const shared = await resolvePlayableReelVideo({
    userId,
    permalink: parsed.permalink,
    shortCode: parsed.shortCode,
    ownerUsername: parsed.ownerUsername ?? null,
  })
  if (shared.reel?.videoUrl) return shared.reel.videoUrl

  const fromPage = await resolveViaPublicPage(parsed.permalink, parsed.shortCode)
  if (fromPage) return fromPage

  const fromYt = await resolveViaYtDlp(parsed.permalink)
  if (fromYt) return fromYt

  throw new Error(formatRecreateScrapeFailure({
    hasRapidApiKey: shared.hasRapidApiKey,
    hasApify: Boolean(process.env.APIFY_API_KEY),
    apifyError: shared.apifyError,
    quotaExhausted: shared.quotaExhausted,
  }))
}
