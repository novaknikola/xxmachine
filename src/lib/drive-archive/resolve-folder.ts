import { one, query } from '@/lib/db'
import { ensureChildFolder } from '@/lib/google-drive'
import { ensureDriveRootFolder } from './ensure-root-folder'
import { normalizeDriveStage, type DriveArchiveKind, type DriveArchiveStage } from './content-format'

const KIND_FOLDER_NAMES: Record<string, string> = {
  stories: 'stories',
  carousels: 'carousels',
  reels: 'reels',
  // Legacy exports (pre content-format picker)
  images: 'images',
  videos: 'videos',
}

/**
 * Resolve (and cache) the leaf Drive folder:
 * XXMachine Archives / {character} / {format} / {ready|raw} / {model}
 */
export async function resolveArchiveFolder(opts: {
  userId: string
  characterKey: string
  kind: DriveArchiveKind | string
  modelKey: string
  stage?: DriveArchiveStage | string | null
  accessToken: string
  rootFolderId?: string | null
}): Promise<string> {
  const characterKey = opts.characterKey || '_none'
  const modelKey = opts.modelKey || '_default'
  const stage = normalizeDriveStage(opts.stage)
  const kindKey = opts.kind in KIND_FOLDER_NAMES ? opts.kind : 'stories'
  const kindFolder = KIND_FOLDER_NAMES[kindKey] ?? 'stories'

  const cached = await one<{ folder_id: string }>(
    `SELECT folder_id FROM drive_folders
      WHERE user_id = $1 AND character_key = $2 AND kind = $3 AND stage = $4 AND model_key = $5`,
    [opts.userId, characterKey, kindKey, stage, modelKey],
  )
  if (cached?.folder_id) return cached.folder_id

  let rootId = opts.rootFolderId ?? null
  if (!rootId) {
    rootId = await ensureDriveRootFolder(opts.accessToken)
    await query(
      `UPDATE users SET drive_root_folder_id = $2 WHERE id = $1`,
      [opts.userId, rootId],
    )
  }

  const characterFolderName = characterKey === '_none' ? '_unsorted' : characterKey
  const characterFolderId = await ensureChildFolder(rootId, characterFolderName, opts.accessToken)
  const formatFolderId = await ensureChildFolder(characterFolderId, kindFolder, opts.accessToken)
  const stageFolderId = await ensureChildFolder(formatFolderId, stage, opts.accessToken)
  const modelFolderName = modelKey === '_default' ? '_default' : modelKey
  const leafId = await ensureChildFolder(stageFolderId, modelFolderName, opts.accessToken)

  await query(
    `INSERT INTO drive_folders (user_id, character_key, kind, stage, model_key, folder_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, character_key, kind, stage, model_key)
     DO UPDATE SET folder_id = EXCLUDED.folder_id`,
    [opts.userId, characterKey, kindKey, stage, modelKey, leafId],
  )

  return leafId
}
