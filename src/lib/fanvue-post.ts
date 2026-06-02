import { FANVUE_API_BASE, FANVUE_API_VERSION } from './fanvue-server'

// Posts to a Fanvue creator account using a stored access token.
// The token must be fetched before calling this (via getFanvueAccessToken).
export async function createFanvuePost(
  accessToken: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  // Step 1: register the external image URL as a Fanvue media object
  const mediaRes = await fetch(`${FANVUE_API_BASE}/v1/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Fanvue-API-Version': FANVUE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: imageUrl }),
  })
  if (!mediaRes.ok) {
    const err = await mediaRes.json().catch(() => ({}))
    throw new Error(`Fanvue media upload failed: ${JSON.stringify(err)}`)
  }
  const media = await mediaRes.json()
  const mediaUuid: string = media.uuid ?? media.data?.uuid

  // Step 2: create the post with the media
  const postRes = await fetch(`${FANVUE_API_BASE}/v1/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Fanvue-API-Version': FANVUE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: caption,
      media_uuids: [mediaUuid],
      visibility: 'subscribers',
    }),
  })
  if (!postRes.ok) {
    const err = await postRes.json().catch(() => ({}))
    throw new Error(`Fanvue post creation failed: ${JSON.stringify(err)}`)
  }
  const post = await postRes.json()
  return post.uuid ?? post.data?.uuid ?? 'unknown'
}
