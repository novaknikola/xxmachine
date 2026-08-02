/**
 * Scene reference URLs — image links pasted straight into a generation form
 * (Pinterest pins, CDN links, anything publicly reachable).
 *
 * These are never downloaded or re-hosted: Seedream fetches each URL itself, so
 * a pasted link costs us no storage and no bandwidth. Verified end to end
 * against i.pinimg.com, which serves unsigned, non-expiring URLs with no
 * referer check.
 */

/** One URL per line; blanks, comments and non-http lines are dropped. */
export function cleanSceneRefUrls(raw: string): string[] {
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    const url = line.trim()
    if (!/^https?:\/\//i.test(url)) continue
    // Deduped so the same pin pasted twice does not silently double the bill.
    seen.add(url)
  }
  return [...seen]
}
