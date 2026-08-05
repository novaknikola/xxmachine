import { one, query, rows } from '@/lib/db'
import { uploadBufferToDriveFolder } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from './user-google-auth'
import { resolveArchiveFolder } from './resolve-folder'
import type { DriveArchiveKind } from './types'

const MAX_ATTEMPTS = 5
const STUCK_UPLOADING_MINUTES = 20
const DEFAULT_LIMIT = 5

export interface ProcessDriveExportsResult {
  processed: number
  done: number
  failed: number
  skipped: number
}

interface DriveExportRow {
  id: string
  user_id: string
  source_url: string
  filename: string
  mime_type: string
  character_key: string
  kind: string
  stage: string
  date_key: string
  model_key: string
  /** '' for every row queued before per-set subfolders existed. */
  series_folder: string
  attempts: number
}

function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(1, attempts))
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`)
  }
  const ab = await res.arrayBuffer()
  if (!ab.byteLength) throw new Error('Download returned empty body')
  return Buffer.from(ab)
}

async function claimNextExport(): Promise<DriveExportRow | null> {
  return one<DriveExportRow>(
    `UPDATE drive_exports e
        SET status = 'uploading',
            attempts = e.attempts + 1,
            next_attempt_at = now(),
            error = NULL
      WHERE e.id = (
        SELECT id FROM drive_exports
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= now()
           AND attempts < $1
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING e.id, e.user_id, e.source_url, e.filename, e.mime_type,
                e.character_key, e.kind, e.stage, e.date_key, e.model_key,
                e.series_folder, e.attempts`,
    [MAX_ATTEMPTS],
  )
}

async function markDone(id: string, driveFileId: string, driveLink: string): Promise<void> {
  await query(
    `UPDATE drive_exports
        SET status = 'done',
            drive_file_id = $2,
            drive_link = $3,
            error = NULL,
            finished_at = now()
      WHERE id = $1`,
    [id, driveFileId, driveLink],
  )
}

async function markFailed(
  id: string,
  attempts: number,
  error: string,
  opts?: { permanent?: boolean },
): Promise<void> {
  const permanent = opts?.permanent || attempts >= MAX_ATTEMPTS
  await query(
    `UPDATE drive_exports
        SET status = 'failed',
            attempts = CASE WHEN $5 THEN GREATEST(attempts, $6) ELSE attempts END,
            error = $2,
            next_attempt_at = CASE
              WHEN $3 THEN now()
              ELSE now() + ($4 || ' minutes')::interval
            END,
            finished_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE id = $1`,
    [
      id,
      error.slice(0, 1000),
      permanent,
      String(backoffMinutes(attempts)),
      permanent,
      MAX_ATTEMPTS,
    ],
  )
}

async function processOne(row: DriveExportRow): Promise<'done' | 'failed' | 'skipped'> {
  const user = await one<{
    google_refresh_token: string | null
    drive_auto_archive: boolean
    drive_root_folder_id: string | null
  }>(
    `SELECT google_refresh_token, drive_auto_archive, drive_root_folder_id
       FROM users WHERE id = $1`,
    [row.user_id],
  )

  if (!user?.google_refresh_token) {
    await markFailed(row.id, row.attempts, 'reconnect_required: Google Drive not connected', {
      permanent: true,
    })
    return 'failed'
  }
  if (!user.drive_auto_archive) {
    await query(
      `UPDATE drive_exports
          SET status = 'skipped', error = 'auto_archive_off', finished_at = now()
        WHERE id = $1`,
      [row.id],
    )
    return 'skipped'
  }

  try {
    const accessToken = await getUserGoogleAccessToken(row.user_id)
    const folderId = await resolveArchiveFolder({
      userId: row.user_id,
      characterKey: row.character_key,
      kind: row.kind as DriveArchiveKind,
      stage: row.stage,
      dateKey: row.date_key,
      accessToken,
      rootFolderId: user.drive_root_folder_id,
      seriesFolder: row.series_folder,
    })
    const buffer = await downloadUrl(row.source_url)
    const uploaded = await uploadBufferToDriveFolder(
      folderId,
      row.filename,
      buffer,
      row.mime_type,
      accessToken,
    )
    await markDone(row.id, uploaded.id, uploaded.link)
    return 'done'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const reconnect =
      /invalid_grant|reconnect|not connected|401|UNAUTHENTICATED/i.test(msg)
    await markFailed(row.id, row.attempts, msg, { permanent: reconnect })
    console.error(`[drive-archive] export ${row.id} failed:`, msg)
    return 'failed'
  }
}

/**
 * Claim and upload up to `limit` pending drive_exports rows.
 * Safe to call from cron; uses SKIP LOCKED so concurrent ticks do not double-upload.
 */
export async function processDriveExports(
  opts: { limit?: number } = {},
): Promise<ProcessDriveExportsResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT

  await query(
    `UPDATE drive_exports
        SET status = 'pending'
      WHERE status = 'uploading'
        AND next_attempt_at < now() - ($1 || ' minutes')::interval`,
    [String(STUCK_UPLOADING_MINUTES)],
  ).catch(err => console.error('[drive-archive] reset stuck uploads:', err))

  const result: ProcessDriveExportsResult = {
    processed: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  }

  for (let i = 0; i < limit; i++) {
    const row = await claimNextExport()
    if (!row) break
    result.processed++
    const outcome = await processOne(row)
    if (outcome === 'done') result.done++
    else if (outcome === 'failed') result.failed++
    else result.skipped++
  }

  return result
}

/** Peek counts for diagnostics / settings. */
export async function countDriveExportStatuses(userId?: string): Promise<Record<string, number>> {
  const list = userId
    ? await rows<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM drive_exports WHERE user_id = $1 GROUP BY status`,
        [userId],
      )
    : await rows<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM drive_exports GROUP BY status`,
      )
  const out: Record<string, number> = {}
  for (const r of list) out[r.status] = Number(r.count)
  return out
}
