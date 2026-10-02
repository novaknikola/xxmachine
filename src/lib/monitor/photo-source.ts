/**
 * Photo Replicator source: a photo clipped from Instagram, copied into our
 * storage the moment it is clipped. Instagram's CDN links are signed and expire
 * (`oe=`), and everything after the clip — the Sheet preview, a generation run
 * days later — needs a copy that does not.
 *
 * Only Instagram/Facebook CDN hosts are fetched, over https, and every redirect
 * is checked against the same list. The bytes must decode as a real JPEG, PNG or
 * WebP of a usable size. The storage path is the SHA-256 of the bytes, so the
 * same photo clipped twice is one object.
 */
import { createHash } from 'crypto'
import sharp, { type Metadata } from 'sharp'
import { publicUrl, uploadBuffer } from '@/lib/supabase-storage'

/** Instagram serves photos from both; a subdomain of either is accepted, nothing else. */
export const PHOTO_SOURCE_HOSTS = ['cdninstagram.com', 'fbcdn.net'] as const
export const MAX_PHOTO_SOURCE_BYTES = 15 * 1024 * 1024
/** Shorter side, in pixels. Below this a generation has nothing to work from. */
export const MIN_PHOTO_SOURCE_SIDE = 320
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 20_000

const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
} as const
type PhotoFormat = keyof typeof FORMATS
const ALLOWED_MIME = new Set<string>(Object.values(FORMATS).map(f => f.mime))

export type PhotoSourceErrorCode =
  | 'INVALID_URL'
  | 'HOST_NOT_ALLOWED'
  | 'FETCH_FAILED'
  | 'TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'TOO_SMALL'
  | 'STORAGE_FAILED'

export class PhotoSourceError extends Error {
  constructor(readonly code: PhotoSourceErrorCode, message: string) {
    super(message)
  }
}

export interface PhotoSource {
  /** Our public storage URL — what the Sheet and everything after it use. */
  url: string
  sha256: string
  width: number
  height: number
  bytes: number
  format: PhotoFormat
  /** True when storage already held these exact bytes and nothing was uploaded. */
  reused: boolean
}

/** The outside world, swapped for fakes in tests. */
export interface PhotoSourceDeps {
  fetch: typeof fetch
  /** Whether our storage already holds `path`. */
  exists(path: string): Promise<boolean>
  upload(buffer: Buffer, path: string, contentType: string): Promise<string>
  publicUrl(path: string): string
}

export const defaultPhotoSourceDeps: PhotoSourceDeps = {
  fetch: (input, init) => fetch(input, init),
  exists: async path => {
    const res = await fetch(publicUrl(path), { method: 'HEAD', signal: AbortSignal.timeout(15_000) }).catch(() => null)
    return !!res?.ok
  },
  upload: (buffer, path, contentType) => uploadBuffer(buffer, path, contentType),
  publicUrl,
}

export function isAllowedPhotoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return PHOTO_SOURCE_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))
}

function checkUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PhotoSourceError('INVALID_URL', 'nije ispravan link slike')
  }
  if (url.protocol !== 'https:') throw new PhotoSourceError('INVALID_URL', 'prihvataju se samo https linkovi slika')
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new PhotoSourceError('HOST_NOT_ALLOWED', 'link slike ima neočekivan nalog ili port')
  }
  if (!isAllowedPhotoHost(url.hostname)) {
    throw new PhotoSourceError('HOST_NOT_ALLOWED', `${url.hostname} nije Instagram/Facebook CDN`)
  }
  return url
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PHOTO_SOURCE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new PhotoSourceError('TOO_LARGE', `slika je veća od ${MAX_PHOTO_SOURCE_BYTES / 1024 / 1024} MB`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Follows redirects by hand so every hop is checked against the allowlist. */
async function download(raw: string, deps: PhotoSourceDeps): Promise<{ buffer: Buffer; contentType: string }> {
  let url = checkUrl(raw)
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await deps.fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err) {
      throw new PhotoSourceError('FETCH_FAILED', `slika nije preuzeta (${err instanceof Error ? err.message : String(err)})`)
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new PhotoSourceError('FETCH_FAILED', `preusmerenje bez adrese (HTTP ${res.status})`)
      if (hop >= MAX_REDIRECTS) throw new PhotoSourceError('FETCH_FAILED', 'previše preusmerenja')
      url = checkUrl(new URL(location, url).href)
      continue
    }
    if (!res.ok) {
      throw new PhotoSourceError('FETCH_FAILED', `Instagram je vratio HTTP ${res.status} — link je možda istekao, klipuj ponovo`)
    }
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_PHOTO_SOURCE_BYTES) {
      throw new PhotoSourceError('TOO_LARGE', `slika je veća od ${MAX_PHOTO_SOURCE_BYTES / 1024 / 1024} MB`)
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_MIME.has(contentType)) {
      throw new PhotoSourceError('NOT_AN_IMAGE', `server je vratio "${contentType || 'nepoznat tip'}", a ne JPEG/PNG/WebP`)
    }
    return { buffer: await readCapped(res), contentType }
  }
}

/** Header says what it is; a full decode proves the pixels are really there. */
async function inspect(buffer: Buffer): Promise<{ format: PhotoFormat; width: number; height: number }> {
  let meta: Metadata
  try {
    meta = await sharp(buffer, { failOn: 'error' }).metadata()
    await sharp(buffer, { failOn: 'error' }).resize(16, 16, { fit: 'inside' }).raw().toBuffer()
  } catch {
    throw new PhotoSourceError('NOT_AN_IMAGE', 'fajl se ne može dekodirati kao slika')
  }
  const format = meta.format as string | undefined
  if (!format || !(format in FORMATS)) {
    throw new PhotoSourceError('NOT_AN_IMAGE', `format "${format ?? 'nepoznat'}" nije JPEG/PNG/WebP`)
  }
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (Math.min(width, height) < MIN_PHOTO_SOURCE_SIDE) {
    throw new PhotoSourceError('TOO_SMALL', `slika je ${width}×${height}, a kraća strana mora imati bar ${MIN_PHOTO_SOURCE_SIDE} px`)
  }
  return { format: format as PhotoFormat, width, height }
}

/**
 * Downloads `imageUrl`, checks it, and stores it at
 * photo-replicator/<userId>/<sha256>.<ext>. A photo already in storage is not
 * uploaded again.
 */
export async function rehostPhotoSource(
  opts: { userId: string; imageUrl: string },
  deps: PhotoSourceDeps = defaultPhotoSourceDeps,
): Promise<PhotoSource> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.userId)) throw new Error('rehostPhotoSource: bad user id')
  const { buffer } = await download(opts.imageUrl, deps)
  const { format, width, height } = await inspect(buffer)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const { mime, ext } = FORMATS[format]
  const path = `photo-replicator/${opts.userId.toLowerCase()}/${sha256}.${ext}`

  let reused = false
  let url: string
  try {
    reused = await deps.exists(path)
    url = reused ? deps.publicUrl(path) : await deps.upload(buffer, path, mime)
  } catch (err) {
    throw new PhotoSourceError('STORAGE_FAILED', `čuvanje slike nije uspelo (${err instanceof Error ? err.message : String(err)})`)
  }
  return { url, sha256, width, height, bytes: buffer.byteLength, format, reused }
}
