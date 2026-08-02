import { createHash } from 'node:crypto'
import type { DriveArchiveKind, DriveArchiveSourceType } from './types'

const RESERVED_KEYS = new Set(['_none', '_default', '_unsorted'])

/**
 * Safe folder/file segment: lowercase, alphanumeric + hyphen/underscore.
 * Preserves reserved keys (_none, _default). Maps legacy "none" → _none.
 */
export function sanitizeDriveKey(raw: string | null | undefined, fallback = '_none'): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return fallback
  const lower = trimmed.toLowerCase()
  if (RESERVED_KEYS.has(lower)) return lower

  const s = lower.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s || s === 'none') return fallback
  return s.slice(0, 80)
}

/** Drive folder name under root for a character key. */
export function characterDriveFolderName(characterKey: string): string {
  const key = sanitizeDriveKey(characterKey)
  if (key === '_none') return '_unsorted'
  return key
}

/** UTC YYYY-MM-DD for day grouping under ready/raw. */
export function archiveDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
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
  /** AI pipeline tag — lives in filename, not folder path. */
  modelKey?: string | null
  /**
   * Groups multiple INDEPENDENT generation calls into one ordered set — e.g.
   * bulk carousel slides, where each slide is its own persistGeneration call
   * (own random sourceId, own single-url `total`=1), so nothing normally ties
   * them together or numbers them. When set, this overrides the id segment
   * (same seriesId → same prefix for every slide) and always appends a
   * zero-padded position, regardless of this call's own `total`.
   */
  seriesId?: string | null
  seriesIndex?: number | null
  seriesTotal?: number | null
}): string {
  const day = archiveDateKey()
  const model = sanitizeDriveKey(opts.modelKey, 'gen').replace(/^_/, '') || 'gen'
  const shortType =
    opts.sourceType === 'generation' ? 'gen'
      : opts.sourceType === 'discovery_item' ? 'disc'
        : 'job'
  const inSeries = !!opts.seriesId && (opts.seriesTotal ?? 0) > 1
  // Hash the whole seriesId rather than slicing its first 8 chars: callers
  // like bulk_carousel build seriesId as `${jobId}:${itemIndex}`, so a plain
  // slice would grab only the (shared, job-wide) prefix and every item in
  // the same job would collide onto one idShort -- their slides would then
  // interleave by position instead of grouping per carousel.
  const idShort = inSeries
    ? hashUrl(opts.seriesId!).slice(0, 8)
    : opts.sourceId.replace(/-/g, '').slice(0, 8)
  const hash8 = hashUrl(opts.url).slice(0, 8)
  const ext = extFromUrl(opts.url, opts.mimeType)
  const position = inSeries ? (opts.seriesIndex ?? 0) + 1 : opts.index + 1
  // Position must sort BEFORE the hash so alphabetical Drive order follows
  // slide sequence — a trailing position after the (random) hash would sort
  // by hash first and scatter the slides anyway.
  const positionTag = inSeries || opts.total > 1 ? `_${String(position).padStart(2, '0')}` : ''
  return `${day}_${model}_${shortType}-${idShort}${positionTag}_${hash8}.${ext}`
}
