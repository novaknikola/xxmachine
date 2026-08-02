/**
 * Scene reference URLs — image links pasted straight into a generation form
 * (Pinterest pins, CDN links, anything publicly reachable).
 *
 * These are never downloaded or re-hosted: Seedream fetches each URL itself, so
 * a pasted link costs us no storage and no bandwidth. Verified end to end
 * against i.pinimg.com, which serves unsigned, non-expiring URLs with no
 * referer check.
 */

/**
 * Reference order is a contract, not a preference: this prompt addresses the
 * images positionally, so image 1 must be the scene and image 2 the identity.
 * Anything that builds a Seedream reference list for a scene edit sends the
 * per-item scene reference first and the character references after it.
 */
export const DEFAULT_SCENE_EDIT_PROMPT =
  'Image 1 is the scene reference, image 2 is the identity reference. Keep the exact pose, camera framing, and background from image 1 unchanged. Replace the main subject\'s face and body identity with the person from image 2. The person must look IDENTICAL to the person in image 2 — same face, same hair colour and styling, same wardrobe, same skin tone and lighting. Only the pose and framing different . Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing. Do not add any other people. Do not change the composition, angle, or background.\nWhite black hair, full bust, no tattoes, athletic body.'

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
