import { query } from '@/lib/db'
import { uploadImagesFromUrls } from '@/lib/supabase-storage'

export interface PersistGenerationInput {
  kind: string
  prompt: string
  wavespeedUrls: string[]
  userId: string
  characterId?: string | null
  characterName?: string | null
  dimension?: string | null
  batch?: number
  /** Override the row timestamp — used when recovering older provider outputs. */
  createdAt?: Date | string | null
}

export interface PersistGenerationResult {
  id: string
  imageUrls: string[]
}

/**
 * Upload Wavespeed outputs to durable storage and insert a `generations` row.
 * Used by Image Studio / Seedream so History does not depend on self-HTTP to BASE_URL.
 */
export async function persistGeneration(
  input: PersistGenerationInput,
): Promise<PersistGenerationResult> {
  if (!input.wavespeedUrls.length) {
    throw new Error('No URLs to persist')
  }
  if (!input.userId) {
    throw new Error('userId required to persist generation')
  }
  if (!input.prompt?.trim()) {
    throw new Error('prompt required to persist generation')
  }

  const genId = crypto.randomUUID()
  const basePath = `${input.userId}/${genId}`

  let permanentUrls: string[]
  try {
    permanentUrls = await uploadImagesFromUrls(input.wavespeedUrls, basePath)
  } catch (err) {
    // Still record history with temporary Wavespeed URLs if Storage is down.
    console.error('[persist-generation] storage upload failed, keeping source URLs:', err)
    permanentUrls = input.wavespeedUrls
  }

  const insert = (characterId: string | null) =>
    query(
      `INSERT INTO generations
        (id, kind, character_id, character_name, prompt, dimension, batch, image_urls, user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))`,
      [
        genId,
        input.kind || 'text2img',
        characterId,
        input.characterName ?? null,
        input.prompt.trim(),
        input.dimension ?? null,
        input.batch ?? permanentUrls.length,
        permanentUrls,
        input.userId,
        input.createdAt ? new Date(input.createdAt).toISOString() : null,
      ],
    )

  const characterId = input.characterId?.trim() || null
  try {
    await insert(characterId)
  } catch (err) {
    // A stale/foreign character id must not cost us the history row.
    if (!characterId) throw err
    console.error('[persist-generation] insert failed, retrying without character_id:', err)
    await insert(null)
  }

  return { id: genId, imageUrls: permanentUrls }
}
