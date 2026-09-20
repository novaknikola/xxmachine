/**
 * Saved character/ambiance "bundles" — a named snapshot of a batch's
 * reference_photos + ambiance_photo_url the user can reload with one tap
 * instead of re-uploading the same photos for every new recreate. Explicit
 * user ask 2026-09-20: "Tiana & Grandpa & Living Room" as one reusable unit,
 * not individual characters picked one at a time.
 */
import { one, query, rows } from '@/lib/db'

export interface SavedBundle {
  id: string
  name: string
  reference_photos: Record<string, string>
  ambiance_photo_url: string | null
}

/** Snapshots the given photos/ambiance under `name`, upserting if the name already exists for this user. */
export async function saveBundle(opts: {
  userId: string
  name: string
  referencePhotos: Record<string, string>
  ambiancePhotoUrl: string | null
}): Promise<SavedBundle> {
  const row = await one<SavedBundle>(
    `INSERT INTO kling_saved_bundles (user_id, name, reference_photos, ambiance_photo_url)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (user_id, name) DO UPDATE SET
       reference_photos = EXCLUDED.reference_photos,
       ambiance_photo_url = EXCLUDED.ambiance_photo_url,
       updated_at = now()
     RETURNING id, name, reference_photos, ambiance_photo_url`,
    [opts.userId, opts.name.trim(), JSON.stringify(opts.referencePhotos), opts.ambiancePhotoUrl],
  )
  if (!row) throw new Error('Could not save bundle')
  return row
}

export async function listBundles(userId: string): Promise<SavedBundle[]> {
  return rows<SavedBundle>(
    `SELECT id, name, reference_photos, ambiance_photo_url
       FROM kling_saved_bundles WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  )
}

export async function getBundle(userId: string, id: string): Promise<SavedBundle | null> {
  return one<SavedBundle>(
    `SELECT id, name, reference_photos, ambiance_photo_url
       FROM kling_saved_bundles WHERE user_id = $1 AND id = $2`,
    [userId, id],
  )
}

export async function deleteBundle(userId: string, id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM kling_saved_bundles WHERE user_id = $1 AND id = $2`,
    [userId, id],
  )
  return (result.rowCount ?? 0) > 0
}
