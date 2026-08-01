import { one, query } from '@/lib/db'
import {
  archiveDateKey,
  buildArchiveFilename,
  guessMimeType,
  hashUrl,
  sanitizeDriveKey,
} from './paths'
import { kickDriveArchiveWorker } from './kick'
import { normalizeDriveStage } from './content-format'
import type { EnqueueDriveArchiveInput } from './types'

export interface EnqueueDriveArchiveResult {
  enqueued: number
  skipped: boolean
  reason?: string
}

/**
 * Queue durable media URLs for async Google Drive upload.
 * No-op when the user has not connected Drive or auto-archive is off.
 * Never throws into the generation pipeline — failures are logged.
 */
export async function enqueueDriveArchive(
  input: EnqueueDriveArchiveInput,
): Promise<EnqueueDriveArchiveResult> {
  const urls = [...new Set(input.urls.filter(u => typeof u === 'string' && u.trim().length > 0))]
  if (!urls.length || !input.userId) {
    return { enqueued: 0, skipped: true, reason: 'no_urls' }
  }

  const user = await one<{
    drive_auto_archive: boolean
    google_refresh_token: string | null
  }>(
    `SELECT drive_auto_archive, google_refresh_token FROM users WHERE id = $1`,
    [input.userId],
  )

  if (!user) {
    return { enqueued: 0, skipped: true, reason: 'user_not_found' }
  }
  if (!user.drive_auto_archive) {
    return { enqueued: 0, skipped: true, reason: 'auto_archive_off' }
  }
  if (!user.google_refresh_token) {
    return { enqueued: 0, skipped: true, reason: 'not_connected' }
  }

  const characterKey = sanitizeDriveKey(input.characterKey)
  const modelKey = sanitizeDriveKey(input.modelKey, '_default')
  const stage = normalizeDriveStage(input.stage)
  const dateKey = (input.dateKey || '').trim() || archiveDateKey()
  let enqueued = 0

  for (let i = 0; i < urls.length; i++) {
    const sourceUrl = urls[i]!
    const mimeType = guessMimeType(sourceUrl, input.kind)
    const urlHash = hashUrl(sourceUrl)
    const filename = buildArchiveFilename({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      url: sourceUrl,
      mimeType,
      index: i,
      total: urls.length,
      modelKey,
      seriesId: input.seriesId,
      seriesIndex: input.seriesIndex,
      seriesTotal: input.seriesTotal,
    })

    const result = await query(
      `INSERT INTO drive_exports
         (user_id, source_type, source_id, source_url, url_hash, filename, mime_type,
          character_key, kind, stage, date_key, model_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
       ON CONFLICT (user_id, source_type, source_id, url_hash) DO NOTHING
       RETURNING id`,
      [
        input.userId,
        input.sourceType,
        input.sourceId,
        sourceUrl,
        urlHash,
        filename,
        mimeType,
        characterKey,
        input.kind,
        stage,
        dateKey,
        modelKey,
      ],
    )
    if (result.rowCount && result.rowCount > 0) enqueued++
  }

  // Provider URLs (Wavespeed) expire, so do not wait for the next cron tick.
  if (enqueued > 0) kickDriveArchiveWorker()

  return { enqueued, skipped: enqueued === 0 }
}
