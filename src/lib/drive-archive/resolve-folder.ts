import { withClient } from '@/lib/db'
import { ensureChildFolder } from '@/lib/google-drive'
import { ensureDriveRootFolder } from './ensure-root-folder'
import {
  driveFormatFolderName,
  normalizeDriveStage,
  type DriveArchiveKind,
  type DriveArchiveStage,
} from './content-format'
import { archiveDateKey, characterDriveFolderName, sanitizeDriveKey } from './paths'
import type { PoolClient } from 'pg'

async function ensureCachedSegment(
  client: PoolClient,
  opts: {
    userId: string
    path: string
    parentId: string
    name: string
    accessToken: string
    characterKey: string
    kind: string
    stage: string
    dateKey: string
  },
): Promise<string> {
  const cached = await client.query<{ folder_id: string }>(
    `SELECT folder_id FROM drive_folders WHERE user_id = $1 AND path = $2`,
    [opts.userId, opts.path],
  )
  if (cached.rows[0]?.folder_id) return cached.rows[0].folder_id

  const folderId = await ensureChildFolder(opts.parentId, opts.name, opts.accessToken)

  await client.query(
    `INSERT INTO drive_folders
       (user_id, character_key, kind, stage, date_key, model_key, path, folder_id)
     VALUES ($1, $2, $3, $4, $5, '_default', $6, $7)
     ON CONFLICT (user_id, path)
     DO UPDATE SET folder_id = EXCLUDED.folder_id`,
    [
      opts.userId,
      opts.characterKey,
      opts.kind,
      opts.stage,
      opts.dateKey,
      opts.path,
      folderId,
    ],
  )

  return folderId
}

/**
 * Resolve (and cache) the leaf Drive folder:
 * XXMachine Archives / {girl} / {stories|carousel|video} / {ready|raw} / {YYYY-MM-DD}
 *
 * Every path segment is cached under a per-user advisory lock so concurrent
 * raw/ready uploads reuse the same girl/format folders instead of creating duplicates.
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
  const formatName = driveFormatFolderName(opts.kind)
  const kindCache = (() => {
    const s = String(opts.kind ?? '').toLowerCase()
    if (s === 'carousel' || s === 'carousels') return 'carousels'
    if (s === 'video' || s === 'reel' || s === 'reels' || s === 'videos') return 'reels'
    return 'stories'
  })()

  const girlName = characterDriveFolderName(characterKey)
  const girlPath = girlName
  const formatPath = `${girlPath}/${formatName}`
  const stagePath = `${formatPath}/${stage}`
  const leafPath = `${stagePath}/${dateKey}`

  const lockKey = `drive-archive:${opts.userId}`

  return withClient(async client => {
    await client.query('SELECT pg_advisory_lock(hashtext($1::text))', [lockKey])
    try {
      const cachedLeaf = await client.query<{ folder_id: string }>(
        `SELECT folder_id FROM drive_folders WHERE user_id = $1 AND path = $2`,
        [opts.userId, leafPath],
      )
      if (cachedLeaf.rows[0]?.folder_id) return cachedLeaf.rows[0].folder_id

      let rootId = opts.rootFolderId ?? null
      if (!rootId) {
        rootId = await ensureDriveRootFolder(opts.accessToken)
        await client.query(
          `UPDATE users SET drive_root_folder_id = $2 WHERE id = $1`,
          [opts.userId, rootId],
        )
      }

      const characterFolderId = await ensureCachedSegment(client, {
        userId: opts.userId,
        path: girlPath,
        parentId: rootId,
        name: girlName,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage: '_',
        dateKey: '_',
      })

      const formatFolderId = await ensureCachedSegment(client, {
        userId: opts.userId,
        path: formatPath,
        parentId: characterFolderId,
        name: formatName,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage: '_',
        dateKey: '_',
      })

      const stageFolderId = await ensureCachedSegment(client, {
        userId: opts.userId,
        path: stagePath,
        parentId: formatFolderId,
        name: stage,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage,
        dateKey: '_',
      })

      return ensureCachedSegment(client, {
        userId: opts.userId,
        path: leafPath,
        parentId: stageFolderId,
        name: dateKey,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage,
        dateKey,
      })
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1::text))', [lockKey])
    }
  })
}
