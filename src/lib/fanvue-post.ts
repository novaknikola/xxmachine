import { FANVUE_API_BASE, FANVUE_API_VERSION } from './fanvue-server'

// Verified against api.fanvue.com/docs 2026-08-19 — the agency/creator-scoped variants,
// since xxmachine holds one agency token acting on behalf of many creators (not a per-creator
// self token). Do not swap in the plain /media/uploads or /posts paths — those are the
// self-only variant and 403 under an agency token.

interface UploadSession {
  mediaUuid: string
  uploadId: string
  partSize: number
  maxParts: number
  totalParts: number | null
}

function headers(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Fanvue-API-Version': FANVUE_API_VERSION,
    'Content-Type': 'application/json',
  }
}

/** Wraps fetch() so a low-level network failure (DNS, TLS, connection reset — the ones that
 *  throw before any Response exists) is tagged with which step it happened in, instead of
 *  surfacing as Node's generic, undifferentiated "fetch failed". */
async function namedFetch(step: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` cause=${String(err.cause)}` : ''
    throw new Error(`${step}_network_error: ${url}${cause}`)
  }
}

async function createUploadSession(
  accessToken: string,
  creatorUuid: string,
  filename: string,
  mediaType: 'image' | 'video' | 'audio' | 'document',
  sizeBytes: number,
): Promise<UploadSession> {
  const res = await namedFetch('create_upload_session', `${FANVUE_API_BASE}/creators/${creatorUuid}/media/uploads`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ name: filename, filename, mediaType, sizeBytes }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`create_upload_session_failed: ${res.status} ${err.slice(0, 300)}`)
  }
  return res.json()
}

async function getUploadPartUrl(
  accessToken: string,
  creatorUuid: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const res = await namedFetch(
    'get_upload_part_url',
    `${FANVUE_API_BASE}/creators/${creatorUuid}/media/uploads/${uploadId}/parts/${partNumber}/url`,
    { headers: headers(accessToken) },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`get_upload_part_url_failed: ${res.status} ${err.slice(0, 300)}`)
  }
  // Plain-text response — the body IS the presigned URL, no wrapper object.
  return (await res.text()).trim()
}

async function completeUploadSession(
  accessToken: string,
  creatorUuid: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
): Promise<void> {
  const res = await namedFetch('complete_upload_session', `${FANVUE_API_BASE}/creators/${creatorUuid}/media/uploads/${uploadId}`, {
    method: 'PATCH',
    headers: headers(accessToken),
    body: JSON.stringify({ parts }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`complete_upload_session_failed: ${res.status} ${err.slice(0, 300)}`)
  }
}

async function waitForMediaReady(
  accessToken: string,
  creatorUuid: string,
  mediaUuid: string,
  { attempts = 10, delayMs = 1500 } = {},
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await namedFetch('wait_for_media_ready', `${FANVUE_API_BASE}/creators/${creatorUuid}/media/${mediaUuid}`, {
      headers: headers(accessToken),
    })
    if (res.ok) {
      const data = await res.json() as { status?: string }
      if (data.status === 'ready') return
      if (data.status === 'error') throw new Error('media_processing_failed')
    }
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error('media_processing_timeout')
}

/** Uploads one image (fetched from `imageUrl`) into a creator's Fanvue media library via the
 *  real S3 multipart flow. Images this size are always one part, but the loop stays generic
 *  in case that assumption ever breaks. Returns the Fanvue mediaUuid. */
async function uploadFanvueImage(accessToken: string, creatorUuid: string, imageUrl: string): Promise<string> {
  const imgRes = await namedFetch('source_image_fetch', imageUrl)
  if (!imgRes.ok) throw new Error(`source_image_fetch_failed: ${imgRes.status}`)
  const bytes = Buffer.from(await imgRes.arrayBuffer())
  const filename = imageUrl.split('/').pop()?.split('?')[0] || `image-${Date.now()}.jpg`

  const session = await createUploadSession(accessToken, creatorUuid, filename, 'image', bytes.length)

  const partSize = session.partSize
  const totalParts = session.totalParts ?? Math.ceil(bytes.length / partSize)
  const parts: { PartNumber: number; ETag: string }[] = []

  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const start = (partNumber - 1) * partSize
    const chunk = bytes.subarray(start, start + partSize)
    const partUrl = await getUploadPartUrl(accessToken, creatorUuid, session.uploadId, partNumber)
    const putRes = await namedFetch('part_upload', partUrl, { method: 'PUT', body: chunk })
    if (!putRes.ok) throw new Error(`part_upload_failed: part ${partNumber} status ${putRes.status}`)
    const etag = putRes.headers.get('etag')
    if (!etag) throw new Error(`part_upload_missing_etag: part ${partNumber}`)
    parts.push({ PartNumber: partNumber, ETag: etag })
  }

  await completeUploadSession(accessToken, creatorUuid, session.uploadId, parts)
  await waitForMediaReady(accessToken, creatorUuid, session.mediaUuid)
  return session.mediaUuid
}

/**
 * Uploads one or more images and creates a single post attaching all of them — Fanvue's own
 * multi-media posts double as carousels, so 2+ imageUrls just means more mediaUuids on the
 * same post. Uploaded sequentially (not in parallel) to keep this predictable under Fanvue's
 * per-agency rate limits, same as everywhere else this file talks to their API.
 */
export async function createFanvuePost(
  accessToken: string,
  creatorUuid: string,
  imageUrls: string[],
  caption: string,
  audience: 'subscribers' | 'followers-and-subscribers' = 'subscribers',
  priceCents?: number,
  /** ISO 8601 future datetime — when set, Fanvue holds and fires the post itself (shows in
   *  their own scheduled-post queue) instead of the post going live immediately. */
  publishAt?: string,
): Promise<string> {
  if (!imageUrls.length) throw new Error('createFanvuePost_no_images')

  const mediaUuids: string[] = []
  for (const imageUrl of imageUrls) {
    mediaUuids.push(await uploadFanvueImage(accessToken, creatorUuid, imageUrl))
  }

  const postRes = await namedFetch('create_post', `${FANVUE_API_BASE}/creators/${creatorUuid}/posts`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      text: caption,
      mediaUuids,
      audience,
      ...(priceCents ? { price: priceCents } : {}),
      ...(publishAt ? { publishAt } : {}),
    }),
  })
  if (!postRes.ok) {
    const err = await postRes.text().catch(() => '')
    throw new Error(`create_post_failed: ${postRes.status} ${err.slice(0, 300)}`)
  }
  const post = await postRes.json() as { uuid?: string }
  return post.uuid ?? 'unknown'
}
