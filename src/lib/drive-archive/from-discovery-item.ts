import { one } from '@/lib/db'
import { enqueueDriveArchive } from './enqueue'
import { copyPasteArchiveLabel } from './label'
import { repurposeImageUrls } from './image-repurpose'
import { repurposeVideoUrls } from './video-repurpose'
import type { ContentFormat, DriveArchiveKind } from './types'

interface DiscoveryArchiveRow {
  user_id: string
  content_type: string | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  image_model: string | null
  video_model: string | null
  /** Source IG handle + shortcode — the derived archive label. */
  profile: string | null
  content_id: string | null
  character_name: string | null
}

export interface ArchiveDiscoveryItemOptions {
  /** Skip video — used when only keyframes are final so far. */
  imagesOnly?: boolean
  /** Avoids a characters lookup when the caller already loaded the persona. */
  characterName?: string | null
}

function imageFormatForContentType(contentType: string | null): ContentFormat {
  if (contentType === 'carousel') return 'carousels'
  return 'stories'
}

/**
 * Queue Copy-Paste finished media for Drive:
 * 1) originals → raw/ (immediate)
 * 2) auto-repurpose → ready/ (background; retry then skip — never original in ready/)
 */
export async function archiveDiscoveryItem(
  itemId: string,
  options: ArchiveDiscoveryItemOptions = {},
): Promise<void> {
  const row = await one<DiscoveryArchiveRow>(
    `SELECT d.user_id,
            d.content_type,
            d.generated_image_url,
            d.generated_end_image_url,
            d.kling_video_url,
            d.image_model,
            d.video_model,
            d.profile,
            d.content_id,
            c.name AS character_name
       FROM discovery_items d
       LEFT JOIN tracked_profiles tp
         ON tp.user_id = d.user_id
        AND tp.platform = d.platform
        AND tp.username = d.profile
       LEFT JOIN characters c ON c.id = tp.character_id
      WHERE d.id = $1`,
    [itemId],
  )
  if (!row) return

  const characterKey = options.characterName ?? row.character_name ?? '_none'
  // Derived, not typed: a Copy-Paste run is a batch over unrelated source reels,
  // so one typed name would label them all identically. The source handle plus
  // shortcode is what you actually look for, and it makes the raw original and
  // its ready/ variants line up by name across the two folders.
  const seriesLabel = copyPasteArchiveLabel(row.profile, row.content_id)
  const imageFormat = imageFormatForContentType(row.content_type)
  const imageKind: DriveArchiveKind = imageFormat

  const imageUrls = [row.generated_image_url, row.generated_end_image_url].filter(
    (u): u is string => Boolean(u),
  )
  const videoUrl = !options.imagesOnly && row.kling_video_url
    ? row.kling_video_url
    : null

  // ── raw/ immediately (fast) ───────────────────────────────────
  if (imageUrls.length) {
    await enqueueDriveArchive({
      userId: row.user_id,
      sourceType: 'discovery_item',
      sourceId: `${itemId}:img`,
      urls: imageUrls,
      characterKey,
      kind: imageKind,
      stage: 'raw',
      modelKey: row.image_model,
      seriesLabel,
    })
  }

  if (videoUrl) {
    await enqueueDriveArchive({
      userId: row.user_id,
      sourceType: 'discovery_item',
      sourceId: `${itemId}:vid`,
      urls: [videoUrl],
      characterKey,
      kind: 'reels',
      stage: 'raw',
      modelKey: row.video_model,
      seriesLabel,
    })
  }

  // ── ready/ in background (ffmpeg can take minutes for video) ──
  void finalizeDiscoveryReady({
    itemId,
    userId: row.user_id,
    characterKey,
    imageUrls,
    imageFormat,
    imageModel: row.image_model,
    videoUrl,
    videoModel: row.video_model,
    seriesLabel,
  }).catch(err =>
    console.error(`[drive-archive] discovery ready pipeline ${itemId} failed:`, err),
  )
}

async function finalizeDiscoveryReady(opts: {
  itemId: string
  userId: string
  characterKey: string
  imageUrls: string[]
  imageFormat: ContentFormat
  imageModel: string | null
  videoUrl: string | null
  videoModel: string | null
  /** Derived from the source reel — same prefix as its raw/ twin. */
  seriesLabel: string
}): Promise<void> {
  const base = `monitor/${opts.itemId}/drive`

  if (opts.imageUrls.length) {
    const { readyUrls, skipped } = await repurposeImageUrls({
      urls: opts.imageUrls,
      format: opts.imageFormat,
      basePath: `${base}/img`,
    })
    if (skipped) {
      console.warn(
        `[drive-archive] discovery ${opts.itemId} image ready skipped ${skipped}/${opts.imageUrls.length}`,
      )
    }
    if (readyUrls.length) {
      await enqueueDriveArchive({
        userId: opts.userId,
        sourceType: 'discovery_item',
        sourceId: `${opts.itemId}:img-ready`,
        urls: readyUrls,
        characterKey: opts.characterKey,
        kind: opts.imageFormat,
        stage: 'ready',
        modelKey: opts.imageModel,
        seriesLabel: opts.seriesLabel,
      })
    }
  }

  if (opts.videoUrl) {
    const { readyUrls, skipped } = await repurposeVideoUrls({
      urls: [opts.videoUrl],
      format: 'reels',
      basePath: `${base}/vid`,
    })
    if (skipped) {
      console.warn(
        `[drive-archive] discovery ${opts.itemId} video ready skipped ${skipped}/1`,
      )
    }
    if (readyUrls.length) {
      await enqueueDriveArchive({
        userId: opts.userId,
        sourceType: 'discovery_item',
        sourceId: `${opts.itemId}:vid-ready`,
        urls: readyUrls,
        characterKey: opts.characterKey,
        kind: 'reels',
        stage: 'ready',
        modelKey: opts.videoModel,
        seriesLabel: opts.seriesLabel,
      })
    }
  }
}
