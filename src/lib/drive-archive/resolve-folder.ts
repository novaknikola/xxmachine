import { withClient, one } from '@/lib/db'
import { ensureChildFolder } from '@/lib/google-drive'
import { ensureDriveRootFolder } from './ensure-root-folder'
import {
  driveFormatFolderName,
  normalizeDriveStage,
  type DriveArchiveKind,
  type DriveArchiveStage,
} from './content-format'
import { archiveDateKey, characterDriveFolderName, sanitizeDriveKey } from './paths'
import { sanitizeArchiveLabel } from './label'
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
/**
 * Every path segment for a set of archive coordinates. Pure — no Drive, no DB —
 * so the layout can be asserted in a test without touching either.
 */
export function archiveFolderPaths(opts: {
  characterKey: string
  kind: DriveArchiveKind | string
  stage?: DriveArchiveStage | string | null
  dateKey?: string | null
  /** Per-set subfolder under the date folder (one carousel). '' = flat, as before. */
  seriesFolder?: string | null
}) {
  const characterKey = sanitizeDriveKey(opts.characterKey)
  const stage = normalizeDriveStage(opts.stage)
  const dateKey = (opts.dateKey || '').trim() || archiveDateKey()
  const formatName = driveFormatFolderName(opts.kind)
  const seriesName = sanitizeArchiveLabel(opts.seriesFolder)
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
  const dayPath = `${stagePath}/${dateKey}`
  // No subfolder → leaf IS the day folder, i.e. exactly the previous layout.
  const leafPath = seriesName ? `${dayPath}/${seriesName}` : dayPath

  return {
    characterKey, stage, dateKey, formatName, kindCache, seriesName,
    girlName, girlPath, formatPath, stagePath, dayPath, leafPath,
  }
}

export async function resolveArchiveFolder(opts: {
  userId: string
  characterKey: string
  kind: DriveArchiveKind | string
  stage?: DriveArchiveStage | string | null
  dateKey?: string | null
  accessToken: string
  rootFolderId?: string | null
  seriesFolder?: string | null
}): Promise<string> {
  const p = archiveFolderPaths(opts)
  const { characterKey, stage, dateKey, formatName, kindCache, girlName } = p
  const { girlPath, formatPath, stagePath, dayPath, leafPath } = p

  const lockKey = `drive-archive:${opts.userId}`

  // Fast path, deliberately OUTSIDE the lock. Once the leaf exists this is a
  // pure cache read that needs no mutual exclusion, and taking a per-user
  // exclusive lock for it serialises every upload for that user behind whoever
  // happens to be creating a folder. Per-carousel subfolders make folder
  // creation far more frequent (one new leaf per carousel instead of one per
  // day), so paying a lock for the common case is no longer defensible.
  const preCached = await one<{ folder_id: string }>(
    `SELECT folder_id FROM drive_folders WHERE user_id = $1 AND path = $2`,
    [opts.userId, leafPath],
  )
  if (preCached?.folder_id) return preCached.folder_id

  return withClient(async client => {
    // Fail fast rather than block: a blocking pg_advisory_lock inside a
    // statement-timeout window turns "another upload is creating a folder" into
    // a hard error with a useless message. drive_exports already has attempts
    // plus exponential backoff, so handing the row back is the cheaper answer.
    // The message must not contain reconnect/not connected/401 — process.ts
    // treats those as permanently failed.
    let locked = false
    for (let i = 0; i < 3 && !locked; i++) {
      const r = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1::text)) AS got',
        [lockKey],
      )
      locked = r.rows[0]?.got === true
      if (!locked) await new Promise(res => setTimeout(res, 200))
    }
    if (!locked) throw new Error('drive folder busy — will retry')
    try {
      // Re-check inside the lock: the race guard for two callers that both
      // missed the fast path above.
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

      const dayFolderId = await ensureCachedSegment(client, {
        userId: opts.userId,
        path: dayPath,
        parentId: stageFolderId,
        name: dateKey,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage,
        dateKey,
      })
      if (!p.seriesName) return dayFolderId

      // One more level: this set's own folder, so a carousel's slides are not
      // mixed in with everything else archived that day.
      return ensureCachedSegment(client, {
        userId: opts.userId,
        path: leafPath,
        parentId: dayFolderId,
        name: p.seriesName,
        accessToken: opts.accessToken,
        characterKey,
        kind: kindCache,
        stage,
        dateKey,
      })
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1::text))', [lockKey])
      }
    }
  })
}
