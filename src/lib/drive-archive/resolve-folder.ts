import { one, withClient } from '@/lib/db'
import { ensureChildFolder } from '@/lib/google-drive'
import { ensureDriveRootFolder } from './ensure-root-folder'
import { driveFormatFolderName, normalizeDriveStage, type DriveArchiveKind, type DriveArchiveStage } from './content-format'
import { archiveDateKey, characterDriveFolderName, sanitizeDriveKey } from './paths'

/**
 * Resolve (and cache) the leaf Drive folder:
 * XXMachine Archives / {girl} / {stories|carousel|video} / {ready|raw} / {YYYY-MM-DD}
 *
 * Uses a per-user advisory lock so concurrent raw+ready uploads do not create
 * duplicate girl folders on Drive.
 */
export async function resolveArchiveFolder(opts: {
  userId: string
  characterKey: string
  kind: DriveArchiveKind | string
  stage?: DriveArchiveStage | string | null
  dateKey?: string | null
  accessToken: string
  rootFolderId?: string | null
}): Promise<string> {
  const characterKey = sanitizeDriveKey(opts.characterKey)
  const stage = normalizeDriveStage(opts.stage)
  const dateKey = (opts.dateKey || '').trim() || archiveDateKey()
  const kindKey = driveFormatFolderName(opts.kind)
  // Keep API kind in cache as the canonical ContentFormat-ish value when possible
  const kindCache = (() => {
    const s = String(opts.kind ?? '').toLowerCase()
    if (s === 'carousel' || s === 'carousels') return 'carousels'
    if (s === 'video' || s === 'reel' || s === 'reels' || s === 'videos') return 'reels'
    return 'stories'
  })()

  const cached = await one<{ folder_id: string }>(
    `SELECT folder_id FROM drive_folders
      WHERE user_id = $1 AND character_key = $2 AND kind = $3 AND stage = $4 AND date_key = $5`,
    [opts.userId, characterKey, kindCache, stage, dateKey],
  )
  if (cached?.folder_id) return cached.folder_id

  const lockKey = `drive-archive:${opts.userId}`

  return withClient(async client => {
    await client.query('SELECT pg_advisory_lock(hashtext($1::text))', [lockKey])
    try {
      const again = await client.query<{ folder_id: string }>(
        `SELECT folder_id FROM drive_folders
          WHERE user_id = $1 AND character_key = $2 AND kind = $3 AND stage = $4 AND date_key = $5`,
        [opts.userId, characterKey, kindCache, stage, dateKey],
      )
      if (again.rows[0]?.folder_id) return again.rows[0].folder_id

      let rootId = opts.rootFolderId ?? null
      if (!rootId) {
        rootId = await ensureDriveRootFolder(opts.accessToken)
        await client.query(
          `UPDATE users SET drive_root_folder_id = $2 WHERE id = $1`,
          [opts.userId, rootId],
        )
      }

      const girlFolder = characterDriveFolderName(characterKey)
      const characterFolderId = await ensureChildFolder(rootId, girlFolder, opts.accessToken)
      const formatFolderId = await ensureChildFolder(characterFolderId, kindKey, opts.accessToken)
      const stageFolderId = await ensureChildFolder(formatFolderId, stage, opts.accessToken)
      const leafId = await ensureChildFolder(stageFolderId, dateKey, opts.accessToken)

      await client.query(
        `INSERT INTO drive_folders (user_id, character_key, kind, stage, date_key, model_key, folder_id)
         VALUES ($1, $2, $3, $4, $5, '_default', $6)
         ON CONFLICT (user_id, character_key, kind, stage, date_key)
         DO UPDATE SET folder_id = EXCLUDED.folder_id`,
        [opts.userId, characterKey, kindCache, stage, dateKey, leafId],
      )

      return leafId
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1::text))', [lockKey])
    }
  })
}
