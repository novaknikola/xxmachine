/**
 * Publish destination chosen at generation time → Drive folder layout.
 * XXMachine Archives / {girl} / {stories|carousel|video} / {ready|raw} / {YYYY-MM-DD} /
 * AI model is encoded in the filename, not a path segment.
 */

export type ContentFormat = 'stories' | 'carousels' | 'reels'

export type DriveArchiveStage = 'ready' | 'raw'

/** Legacy kinds still accepted from older queued exports / discovery. */
export type DriveArchiveKind = ContentFormat | 'images' | 'videos'

export const CONTENT_FORMATS: { id: ContentFormat; label: string; hint: string }[] = [
  { id: 'stories', label: 'Story', hint: '9:16 stills for IG/TikTok stories' },
  { id: 'carousels', label: 'Carousel', hint: 'Multi-image posts' },
  { id: 'reels', label: 'Video / Reel', hint: 'Keyframe or clip destined for reels' },
]

/** Human folder name under the girl folder. */
export function driveFormatFolderName(kind: DriveArchiveKind | string): string {
  const s = String(kind ?? '').trim().toLowerCase()
  if (s === 'carousel' || s === 'carousels') return 'carousel'
  if (s === 'video' || s === 'reel' || s === 'reels' || s === 'videos') return 'video'
  return 'stories'
}

export function normalizeContentFormat(raw: unknown): ContentFormat {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'story' || s === 'stories') return 'stories'
  if (s === 'carousel' || s === 'carousels') return 'carousels'
  if (s === 'video' || s === 'reel' || s === 'reels') return 'reels'
  return 'stories'
}

export function normalizeDriveStage(raw: unknown): DriveArchiveStage {
  return String(raw ?? '').trim().toLowerCase() === 'raw' ? 'raw' : 'ready'
}

/** Suggested aspect ratio when the user picks a format. */
export function suggestedDimensionForFormat(format: ContentFormat): string {
  if (format === 'carousels') return '4:5'
  return '9:16'
}
