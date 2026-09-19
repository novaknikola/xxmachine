import { query } from '@/lib/db'
import { DRIVE_UPLOAD_RETRYABLE, ensureChildFolder, uploadBufferToDriveFolder } from '@/lib/google-drive'
import { forceRefreshUserGoogleAccessToken, getUserGoogleAccessToken } from './user-google-auth'

/**
 * Atomic per-folder counter for iPhone-style sequential naming (IMG_0001...).
 * Multiple source files in the same repurpose batch upload into the same
 * "Package_N_of_COUNT" subfolder concurrently, so a race-free DB counter is
 * used instead of listing+counting the folder each time. Gaps after a
 * retried upload are fine — real iPhone rolls have gaps too.
 */
async function nextIphoneSequence(userId: string, folderId: string): Promise<number> {
  const { rows } = await query<{ counter: number }>(
    `INSERT INTO drive_upload_sequences (folder_id, user_id, counter, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (folder_id) DO UPDATE
       SET counter = drive_upload_sequences.counter + 1, updated_at = now()
     RETURNING counter`,
    [folderId, userId],
  )
  return rows[0]!.counter
}

/**
 * Uploads one repurpose variant grouped by variation index instead of flat
 * "<name>_00N.ext" naming: each variantIdx gets its own "Package_N_of_COUNT"
 * subfolder under outputDriveFolderId, renamed IMG_0001.ext.. sequentially
 * within it — so folder N is a complete, ready-to-post set on its own,
 * whether it came from one source file or a whole batch sharing this folder.
 */
export async function uploadRepurposeVariantGrouped(
  userId: string,
  outputDriveFolderId: string,
  variantIdx: number,
  count: number,
  buffer: Buffer,
  mimeType: string,
  ext: string,
  maxAttempts = 3,
): Promise<{ id: string; link: string }> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const token = attempt === 0
        ? await getUserGoogleAccessToken(userId)
        : await forceRefreshUserGoogleAccessToken(userId)
      const subfolderId = await ensureChildFolder(
        outputDriveFolderId,
        `Package_${variantIdx + 1}_of_${count}`,
        token,
      )
      const seq = await nextIphoneSequence(userId, subfolderId)
      const filename = `IMG_${String(seq).padStart(4, '0')}${ext}`
      return await uploadBufferToDriveFolder(subfolderId, filename, buffer, mimeType, token)
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const retryable = DRIVE_UPLOAD_RETRYABLE.test(lastErr.message)
      if (!retryable || attempt >= maxAttempts - 1) throw lastErr
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw lastErr ?? new Error('Drive grouped upload failed')
}
