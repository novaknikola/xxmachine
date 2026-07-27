/** True when the URL looks like a direct media file, not an Instagram web page. */
export function isPlayableVideoUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  // Instagram HTML pages are never downloadable video binaries.
  if (host === 'instagram.com' || host === 'www.instagram.com') return false
  if (host.endsWith('.instagram.com') && !host.includes('cdninstagram') && !host.includes('fbcdn')) {
    // e.g. l.instagram.com redirects — not a binary.
    if (!/\.(mp4|m4v|mov)(\?|$)/i.test(parsed.pathname)) return false
  }
  return true
}
