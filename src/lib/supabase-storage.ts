const BUCKET = 'generations'

function storageUrl(path: string) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`
}

function publicUrl(path: string) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
}

function storageHeaders(key: string, contentType?: string) {
  const h: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  if (contentType) h['Content-Type'] = contentType
  return h
}

export async function uploadImageFromUrl(
  wavespeedUrl: string,
  path: string,
): Promise<string> {
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!key || !process.env.SUPABASE_URL) throw new Error('SUPABASE_SERVICE_KEY not configured')

  // Download from Wavespeed
  const imgRes = await fetch(wavespeedUrl, { signal: AbortSignal.timeout(30_000) })
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`)
  const buffer = await imgRes.arrayBuffer()
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg'

  // Upload to Supabase Storage
  const uploadRes = await fetch(storageUrl(path), {
    method: 'POST',
    headers: { ...storageHeaders(key, contentType), 'x-upsert': 'true' },
    body: buffer,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}))
    throw new Error(`Storage upload failed: ${(err as { message?: string }).message ?? uploadRes.status}`)
  }

  return publicUrl(path)
}

export async function uploadImagesFromUrls(
  wavespeedUrls: string[],
  basePath: string,
): Promise<string[]> {
  return Promise.all(
    wavespeedUrls.map((url, i) =>
      uploadImageFromUrl(url, `${basePath}/${i + 1}.jpg`)
    )
  )
}
