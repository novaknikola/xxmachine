/** Pure Instagram media-URL extractors. No Node deps — used by scrape + a self-check. */

function isPlayableVideoUrl(url) {
  if (!url?.trim()) return false
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'instagram.com' || host === 'www.instagram.com') return false
  if (host.endsWith('.instagram.com') && !host.includes('cdninstagram') && !host.includes('fbcdn')) {
    if (!/\.(mp4|m4v|mov)(\?|$)/i.test(parsed.pathname)) return false
  }
  return true
}

function unescapeJsonish(s) {
  return s
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
}

/** CDN mp4 (or Instagram's dst-mp4 signed URL), not a jpg thumb or HTML page. */
export function looksLikeDirectVideoUrl(url) {
  if (!url || !isPlayableVideoUrl(url)) return false
  const u = url.toLowerCase()
  if (/\.(jpe?g|png|webp|gif)(\?|$)/.test(u)) return false
  if (/\.(mp4|m4v|mov)(\?|$)/.test(u)) return true
  if (u.includes('stp=dst-mp4')) return true
  if (u.includes('/o1/v/t') || u.includes('/v/t66.') || u.includes('/v/t16.')) return true
  return /video/i.test(u)
}

/**
 * Walk a downloader / GraphQL / embed JSON blob for the first playable mp4.
 * Expected leaves: `video_url`, `videoUrl`, `video_versions[].url`, `medias[].url`.
 */
export function findPlayableVideoUrl(data, depth = 0) {
  if (depth > 10 || data == null) return null
  if (typeof data === 'string') {
    const url = unescapeJsonish(data.trim())
    return looksLikeDirectVideoUrl(url) ? url : null
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findPlayableVideoUrl(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof data !== 'object') return null
  const rec = data
  for (const key of ['video_url', 'videoUrl', 'contentUrl', 'playback_url', 'src']) {
    const found = findPlayableVideoUrl(rec[key], depth + 1)
    if (found) return found
  }
  for (const key of ['video_versions', 'videos', 'medias', 'media', 'data', 'result', 'items']) {
    const found = findPlayableVideoUrl(rec[key], depth + 1)
    if (found) return found
  }
  for (const value of Object.values(rec)) {
    const found = findPlayableVideoUrl(value, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * yt-dlp-style parse of an Instagram HTML/embed page: og:video, JSON `video_url`,
 * `video_versions`, JSON-LD contentUrl, raw CDN mp4s.
 */
export function extractPlayableVideoUrlFromHtml(html) {
  if (!html) return null

  const meta = html.matchAll(
    /<meta[^>]+(?:property|name)=["']og:video(?::secure_url)?["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
  )
  for (const m of meta) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const contentFirst = html.matchAll(
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:video(?::secure_url)?["'][^>]*>/gi,
  )
  for (const m of contentFirst) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const jsonLd = html.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)
  for (const m of jsonLd) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const videoUrlFields = html.matchAll(/"(?:video_url|videoUrl|playback_url)"\s*:\s*"([^"]+)"/g)
  for (const m of videoUrlFields) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const versionUrls = html.matchAll(/"url"\s*:\s*"(https:[^"]+)"/g)
  for (const m of versionUrls) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const videoSrc = html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)
  for (const m of videoSrc) {
    const url = unescapeJsonish(m[1] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  const raw = html.matchAll(/https?:\/\/[^"'\\\s<>]+/g)
  for (const m of raw) {
    const url = unescapeJsonish(m[0] ?? '')
    if (looksLikeDirectVideoUrl(url)) return url
  }

  return null
}

/** RapidAPI "upgrade / not subscribed" — not the reason a reel is restricted. */
export function isRapidApiPlanNoise(message) {
  return /not subscribed|undergoing an upgrade|not been used in a while|subscribe to this api/i.test(
    message,
  )
}

/**
 * Prefer the actor's real verdict over RapidAPI plan noise.
 * restricted_page means Instagram gated the anonymous scrape — not that
 * the RapidAPI downloader subscription is why we have no mp4.
 */
export function composeRecreateScrapeError(notes) {
  const restricted = notes.find(n => /restricted_page|restricted|login.walled|age.?gate/i.test(n.detail))
  const useful = notes.filter(n => !isRapidApiPlanNoise(n.detail))
  if (restricted) {
    const extra = useful
      .filter(n => n !== restricted)
      .map(n => `${n.source}: ${n.detail}`)
      .slice(0, 3)
    return [
      `Instagram blocked anonymous access to this reel (${restricted.detail}).`,
      'It is login-walled, age-gated, or region-restricted — not a RapidAPI subscription issue.',
      extra.length ? extra.join(' · ') : '',
      'Last resort: send the reel as a video file.',
    ].filter(Boolean).join(' ')
  }
  if (useful.length) {
    return `Could not resolve a playable video URL. ${useful.map(n => `${n.source}: ${n.detail}`).join(' · ')}. Last resort: send the reel as a video file.`
  }
  return 'Could not resolve a playable video URL from public Instagram scrapers. Last resort: send the reel as a video file.'
}
