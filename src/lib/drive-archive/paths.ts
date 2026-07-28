import { createHash } from 'node:crypto'
import type { DriveArchiveKind, DriveArchiveSourceType } from './types'

/** Safe folder/file segment: lowercase, alphanumeric + hyphen/underscore. */
export function sanitizeDriveKey(raw: string | null | undefined, fallback = '_none'): string {
  const s = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return (s.slice(0, 80) || fallback)
}

export function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function extFromUrl(url: string, mimeType: string): string {
  try {
    const path = new URL(url).pathname
    const m = path.match(/\.([a-z0-9]{2,5})$/i)
    if (m) return m[1].toLowerCase()
  } catch {
    /* ignore */
  }
  if (mimeType.startsWith('video/')) return 'mp4'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

export function guessMimeType(url: string, kind: DriveArchiveKind): string {
  const lower = url.toLowerCase()
  if (lower.includes('.png')) return 'image/png'
  if (lower.includes('.webp')) return 'image/webp'
  if (lower.includes('.gif')) return 'image/gif'
  if (
    lower.includes('.mp4')
    || lower.includes('.webm')
    || kind === 'videos'
    || kind === 'reels'
  ) {
    return 'video/mp4'
  }
  return 'image/jpeg'
}

export function buildArchiveFilename(opts: {
  sourceType: DriveArchiveSourceType
  sourceId: string
  url: string
  mimeType: string
  index: number
  total: number
}): string {
  const day = new Date().toISOString().slice(0, 10)
  const shortType =
    opts.sourceType === 'generation' ? 'gen'
      : opts.sourceType === 'discovery_item' ? 'disc'
        : 'job'
  const idShort = opts.sourceId.replace(/-/g, '').slice(0, 8)
  const hash8 = hashUrl(opts.url).slice(0, 8)
  const ext = extFromUrl(opts.url, opts.mimeType)
  const suffix = opts.total > 1 ? `_${opts.index + 1}` : ''
  return `${day}_${shortType}-${idShort}_${hash8}${suffix}.${ext}`
}
