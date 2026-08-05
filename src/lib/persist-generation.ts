import { query } from '@/lib/db'
import { uploadImagesFromUrls } from '@/lib/supabase-storage'
import {
  normalizeContentFormat,
  type ContentFormat,
} from '@/lib/drive-archive/content-format'
import { repurposeImageUrls } from '@/lib/drive-archive/image-repurpose'

export interface PersistGenerationInput {
  kind: string
  prompt: string
  wavespeedUrls: string[]
  userId: string
  characterId?: string | null
  characterName?: string | null
  dimension?: string | null
  batch?: number
  /** Publish destination: stories | carousels | reels */
  contentFormat?: ContentFormat | string | null
  /** Skip auto-repurpose (rare). Default false. */
  skipRepurpose?: boolean
  /** Override the row timestamp — used when recovering older provider outputs. */
  createdAt?: Date | string | null
  /**
   * Groups this call with sibling persistGeneration calls into one ordered
   * Drive set — e.g. bulk carousel slides, each generated via its own
   * independent call. Same seriesId across the batch + this slide's
   * 0-based position + the batch size. See buildArchiveFilename.
   */
  seriesId?: string | null
  seriesIndex?: number | null
  seriesTotal?: number | null
  /** User-chosen base name; blank keeps the machine-generated filename. */
  seriesLabel?: string | null
  /** Per-set Drive subfolder (one carousel). */
  seriesFolder?: string | null
}

export interface PersistGenerationResult {
  id: string
  imageUrls: string[]
  readyUrls: string[]
}

/**
 * Upload Wavespeed outputs to durable storage and insert a `generations` row.
 * Then auto-repurpose into format-specific variants and enqueue Drive raw/ + ready/.
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
  const contentFormat = normalizeContentFormat(input.contentFormat)
  // `??` would let an empty-string name win over a perfectly good id and drop the
  // whole generation into _unsorted/, so fall through on blanks too.
  const characterKey =
    input.characterName?.trim() || input.characterId?.trim() || '_none'
  const modelKey = input.kind || 'text2img'

  let permanentUrls: string[]
  try {
    permanentUrls = await uploadImagesFromUrls(input.wavespeedUrls, basePath)
  } catch (err) {
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
    if (!characterId) throw err
    console.error('[persist-generation] insert failed, retrying without character_id:', err)
    await insert(null)
  }

  // Auto-repurpose → ready URLs only. Never put originals in ready/ (retry then skip).
  let readyUrls: string[] = []
  if (!input.skipRepurpose) {
    try {
      const result = await repurposeImageUrls({
        urls: permanentUrls,
        format: contentFormat,
        basePath,
      })
      readyUrls = result.readyUrls
      if (result.skipped) {
        console.warn(
          `[persist-generation] repurpose skipped ${result.skipped}/${permanentUrls.length} (no ready fallback)`,
        )
      }
    } catch (err) {
      console.error('[persist-generation] repurpose failed entirely — ready/ not enqueued:', err)
      readyUrls = []
    }
  }

  const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
  const driveMeta = {
    userId: input.userId,
    sourceType: 'generation' as const,
    sourceId: genId,
    characterKey,
    kind: contentFormat,
    modelKey,
    seriesId: input.seriesId,
    seriesIndex: input.seriesIndex,
    seriesTotal: input.seriesTotal,
    seriesLabel: input.seriesLabel,
    seriesFolder: input.seriesFolder,
  }

  // Originals → raw/ only. Ready variants → ready/ (VA) — only successful repurposes.
  await enqueueDriveArchive({
    ...driveMeta,
    urls: permanentUrls,
    stage: 'raw',
  }).catch(err => console.error('[persist-generation] drive raw enqueue failed:', err))

  if (readyUrls.length) {
    await enqueueDriveArchive({
      ...driveMeta,
      urls: readyUrls,
      stage: 'ready',
    }).catch(err => console.error('[persist-generation] drive ready enqueue failed:', err))
  }

  return { id: genId, imageUrls: permanentUrls, readyUrls }
}
