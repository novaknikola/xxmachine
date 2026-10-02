import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireApiToken } from '@/lib/api-token'
import { characterDriveKey, listCharacters } from '@/lib/content-ops/characters'
import { driveFormatFolderName } from '@/lib/drive-archive/content-format'
import { IGREPLICATOR_DRIVE_SECTION } from '@/lib/drive-archive/paths'
import { archiveFolderPaths } from '@/lib/drive-archive/resolve-folder'
import { FARM_IMAGE_FORMATS, type FarmImageFormat } from '@/lib/content-ops/image-repurpose'

/**
 * The farm's view of the Replicator: every character and the Drive folder its
 * unedited reels land in. Folder ids come from the archive's own path cache —
 * a character root can be named "tiana_goth (2)" on Drive, so the farm must
 * never look folders up by name.
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const characters = await listCharacters(auth.id)
  const rawPaths = characters.map(c =>
    `${IGREPLICATOR_DRIVE_SECTION}/${characterDriveKey(c.name)}/${driveFormatFolderName('reels')}/raw`)
  // Photo Replicator: approved photos land in <character>/<Post|stories|carousel>/raw.
  const imageFormats = Object.keys(FARM_IMAGE_FORMATS) as FarmImageFormat[]
  const imagePath = (name: string, format: FarmImageFormat) => archiveFolderPaths({
    characterKey: characterDriveKey(name), kind: FARM_IMAGE_FORMATS[format], stage: 'raw', section: IGREPLICATOR_DRIVE_SECTION,
  }).stagePath
  const imagePaths = characters.flatMap(c => imageFormats.map(f => imagePath(c.name, f)))
  const cached = await rows<{ path: string; folder_id: string }>(
    `SELECT path, folder_id FROM drive_folders WHERE user_id = $1 AND path = ANY($2::text[])`,
    [auth.id, [...rawPaths, ...imagePaths]],
  )
  const byPath = new Map(cached.map(r => [r.path, r.folder_id]))

  return NextResponse.json({
    characters: characters.map((c, i) => ({
      id: c.id,
      name: c.name,
      key: characterDriveKey(c.name),
      hasReference: Boolean(c.reference_image_url),
      // Null until the first reel for this character has been archived.
      rawFolderId: byPath.get(rawPaths[i]) ?? null,
      // Same, per image format: null until the first approved photo of that format.
      imageRawFolders: Object.fromEntries(imageFormats.map(f => [f, byPath.get(imagePath(c.name, f)) ?? null])),
    })),
  })
}
