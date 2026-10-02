/**
 * Photo Replicator phase 2 — the paid part and its Telegram preview.
 *
 * The same still workflow as the IG Replicator's scene still (wan-jobs.ts):
 * Seedream v5 Pro Edit of [source photo, character reference] with the
 * character's wan_prompt + the row's addition, then the Z-Image Turbo skin pass.
 * A carousel's further slides are pose variants edited off the raw base
 * (never off the source, never off an already skin-enhanced slide), the way
 * copy_prompts_generate does it. No Wan call anywhere.
 */
import sharp from 'sharp'
import { one, query } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { uploadBuffer, uploadImageFromUrl } from '@/lib/supabase-storage'
import { editImage, finalizeWithSkinEnhance } from '@/lib/wavespeed'
import { getCarouselVariantPrompts } from '@/lib/carousel-presets'
import { renderCarouselVariantPrompt } from '@/lib/pose-recreate'
import { composeStillPrompt, getCharacter } from '@/lib/content-ops/characters'
import { sendMediaGroup, sendPhoto, sendTextWithKeyboard } from '@/lib/telegram'
import { notifyMonitorUser } from './notify'
import { renderWanStillPrompt } from './wan-jobs'
import {
  MAX_PHOTO_GENERATIONS,
  getPhotoJob,
  markPhotoJobFailed,
  type PhotoErrorCode,
  type PhotoFormat,
  type PhotoJobRow,
  type PhotoSlide,
} from './photo-jobs'

/**
 * Aspect per format. Feed posts and carousels are 4:5 — Instagram's tallest
 * feed ratio, so nothing is cropped away on the phone; stories are 9:16.
 */
export const PHOTO_ASPECT: Record<PhotoFormat, '4:5' | '9:16'> = {
  post: '4:5',
  story: '9:16',
  carousel: '4:5',
}

/**
 * Explicit W*H for the skin pass. DIMENSION_MAP (wavespeed.ts) has no 4:5 and
 * enhanceSkin passes an unknown key through as-is, so '4:5' would reach Z-Image
 * as a size it can't read. A size here leaves the shared map — and every other
 * pipeline — untouched. ~1 MP, multiples of 32, like the map's own sizes.
 */
export const PHOTO_SKIN_SIZE: Record<'4:5' | '9:16', string> = {
  '4:5': '896*1120',
  '9:16': '756*1344',
}

/** Pose variants for carousel slides 2+ (carousel-presets.ts). */
export const PHOTO_CAROUSEL_PRESET = 'body-language'

const CALL_TIMEOUT_MS = 600_000

export function photoStoragePath(jobId: string, attempt: number, name: string): string {
  return `photo-replicator/jobs/${jobId}/a${attempt}-${name}`
}

/** Buttons under a preview; data is `<action>:<photo job id>:<attempt>`, so a stale preview's buttons do nothing. */
export function photoApprovalKeyboard(jobId: string, attempt: number) {
  const row = [{ text: '✅ Approve', callback_data: `phok:${jobId}:${attempt}` }]
  if (attempt < MAX_PHOTO_GENERATIONS) {
    row.push({ text: `🔁 Regenerate (${attempt}/${MAX_PHOTO_GENERATIONS})`, callback_data: `phre:${jobId}:${attempt}` })
  }
  row.push({ text: '✖️ Reject', callback_data: `phno:${jobId}:${attempt}` })
  return { inline_keyboard: [row] }
}

const FORMAT_LABEL: Record<PhotoFormat, string> = { post: 'Post', story: 'Story', carousel: 'Carousel' }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function photoPreviewCaption(job: PhotoJobRow, characterName: string): string {
  return [
    `🖼 <b>Photo Replicator</b> — ${escapeHtml(characterName)} · ${FORMAT_LABEL[job.format]}${job.format === 'carousel' ? ` · ${job.slides} slajda` : ''}`,
    `Pokušaj ${job.attempt}/${MAX_PHOTO_GENERATIONS}${job.attempt >= MAX_PHOTO_GENERATIONS ? ' (poslednji)' : ''}`,
    job.source_link ? `Izvor: ${escapeHtml(job.source_link)}` : '',
    job.prompt_addition ? `Dodatak: ${escapeHtml(job.prompt_addition.slice(0, 300))}` : '',
    'Approve → Drive raw → farma. Ništa ne ide dalje bez Approve.',
  ].filter(Boolean).join('\n')
}

/** Download a finished image and store it as a real JPEG (the skin pass returns PNG bytes). */
async function storeSlide(url: string, path: string): Promise<{ url: string; width: number; height: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Download of the generated image failed: ${res.status}`)
  const jpeg = await sharp(Buffer.from(await res.arrayBuffer())).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  const meta = await sharp(jpeg).metadata()
  return { url: await uploadBuffer(jpeg, path, 'image/jpeg'), width: meta.width ?? 0, height: meta.height ?? 0 }
}

class PhotoGenerationError extends Error {
  constructor(readonly code: PhotoErrorCode, message: string) {
    super(message)
  }
}

function classify(err: unknown): PhotoErrorCode {
  if (err instanceof PhotoGenerationError) return err.code
  const msg = err instanceof Error ? err.message : String(err)
  if (/Storage upload failed|SUPABASE_SERVICE_KEY/i.test(msg)) return 'STORAGE_FAILED'
  if (/No API key configured|\b401\b|unauthori[sz]ed/i.test(msg)) return 'REPLICATOR_UNAVAILABLE'
  return 'GENERATION_FAILED'
}

export interface PhotoGenerationResult {
  jobId: string
  attempt: number
  slides: (PhotoSlide & { width: number; height: number })[]
  previewSent: boolean
}

/**
 * One generation of a 'queued' job (the queue worker's photo_replicator
 * branch). The claim is the only way in, so a duplicate queue job or a second
 * worker finds nothing to do and pays nothing. A failure fails the job with
 * its reason and throws; nothing is retried automatically.
 */
export async function runPhotoGeneration(
  jobId: string,
  userId: string,
  opts: { heartbeat?: () => Promise<unknown> } = {},
): Promise<PhotoGenerationResult> {
  const job = await one<PhotoJobRow>(
    `UPDATE photo_replicator_jobs
        SET status = 'generating', attempt = attempt + 1, started_at = COALESCE(started_at, now()),
            result = NULL, prompt = NULL, preview_message_ids = NULL, preview_sent_at = NULL,
            error = NULL, error_code = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'queued' AND attempt < $3
      RETURNING *`,
    [jobId, userId, MAX_PHOTO_GENERATIONS],
  )
  if (!job) {
    const current = await getPhotoJob(jobId, userId)
    if (current?.status === 'queued' && current.attempt >= MAX_PHOTO_GENERATIONS) {
      await markPhotoJobFailed(jobId, 'REGEN_LIMIT', `Iskorišćeno ${MAX_PHOTO_GENERATIONS} generisanja za ovaj job`)
      throw new Error(`Photo job ${jobId} is out of generations`)
    }
    throw new Error(`Photo job ${jobId} is ${current?.status ?? 'missing'} — not generating it again`)
  }
  console.log(`[photo-generate] job ${jobId} generation ${job.attempt}/${MAX_PHOTO_GENERATIONS} (${job.format}${job.format === 'carousel' ? ` ×${job.slides}` : ''})`)

  try {
    const character = job.character_id ? await getCharacter(userId, job.character_id) : null
    if (!character?.reference_image_url) {
      throw new PhotoGenerationError('INVALID_INPUT', 'Karakter ne postoji ili nema referentnu fotografiju')
    }
    const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')
    const aspect = PHOTO_ASPECT[job.format]
    const skinSize = PHOTO_SKIN_SIZE[aspect]
    const additions = composeStillPrompt(character.wan_prompt, job.prompt_addition)
    const basePrompt = renderWanStillPrompt(additions)
    const source = job.resolved_source_url ?? job.source_url

    const base = await editImage({
      imageUrls: [source, character.reference_image_url],
      prompt: basePrompt,
      size: aspect,
      apiKey,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!base.length) throw new PhotoGenerationError('GENERATION_FAILED', 'Seedream returned no image')
    // The raw base is what carousel variants edit; stored so it outlives the provider link.
    const rawBase = await uploadImageFromUrl(base[0], photoStoragePath(jobId, job.attempt, 'base-raw.jpg'))
    await opts.heartbeat?.()

    const variantPrompts = job.format === 'carousel'
      ? getCarouselVariantPrompts(PHOTO_CAROUSEL_PRESET, job.slides - 1, additions).map(renderCarouselVariantPrompt)
      : []
    if (variantPrompts.length !== job.slides - 1) {
      throw new PhotoGenerationError('GENERATION_FAILED', `Carousel preset gave ${variantPrompts.length} of ${job.slides - 1} variant prompts`)
    }

    const finish = async (rawUrl: string, index: number, prompt: string) => {
      const enhanced = await finalizeWithSkinEnhance(rawUrl, skinSize, apiKey, AbortSignal.timeout(CALL_TIMEOUT_MS))
      const stored = await storeSlide(enhanced, photoStoragePath(jobId, job.attempt, `${String(index + 1).padStart(2, '0')}.jpg`))
      await opts.heartbeat?.()
      return { ...stored, prompt }
    }

    // Every slide must exist — a carousel with a missing slide is not a carousel.
    const slides = await Promise.all([
      finish(rawBase, 0, basePrompt),
      ...variantPrompts.map(async (prompt, i) => {
        const edited = await editImage({
          imageUrls: [rawBase],
          prompt,
          size: aspect,
          apiKey,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
        if (!edited.length) throw new PhotoGenerationError('GENERATION_FAILED', `Seedream returned no image for slide ${i + 2}`)
        return finish(edited[0], i + 1, prompt)
      }),
    ])

    const result: PhotoSlide[] = slides.map(s => ({ url: s.url, prompt: s.prompt }))
    const ready = await one<PhotoJobRow>(
      `UPDATE photo_replicator_jobs
          SET status = 'awaiting_approval', result = $2::jsonb, prompt = $3, updated_at = now()
        WHERE id = $1 AND status = 'generating'
        RETURNING *`,
      [jobId, JSON.stringify(result), basePrompt],
    )
    if (!ready) throw new Error('Photo job left generating while it was being generated')
    console.log(`[photo-generate] job ${jobId} generation ${job.attempt} ready: ${slides.map(s => `${s.width}x${s.height}`).join(', ')}`)

    const previewSent = await sendPhotoPreview(ready, character.name)
    return { jobId, attempt: job.attempt, slides, previewSent }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = classify(err)
    // Only a job still generating is failed here — a preview failure already said why.
    await query(
      `UPDATE photo_replicator_jobs
          SET status = 'failed', error = $2, error_code = $3, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'generating'`,
      [jobId, msg.slice(0, 1000), code],
    )
    console.error(`[photo-generate] job ${jobId} generation ${job.attempt} failed [${code}]: ${msg}`)
    await notifyMonitorUser(userId, `❌ Photo Replicator: generisanje nije uspelo (${code}). Čekiraj Pošalji u Sheet-u za novi pokušaj.`).catch(() => {})
    throw err
  }
}

/**
 * The preview in Telegram: one photo with the buttons (post, story), or the
 * album plus a separate message with the buttons (carousel — an album can't
 * carry a keyboard). Sending it again is harmless: the buttons carry the
 * attempt, and the approval is one conditional UPDATE.
 */
export async function sendPhotoPreview(job: PhotoJobRow, characterName?: string): Promise<boolean> {
  const slides = Array.isArray(job.result) ? job.result : []
  if (!job.chat_id || slides.length !== job.slides) {
    await markPhotoJobFailed(job.id, 'PREVIEW_FAILED', job.chat_id ? 'Rezultat nije kompletan' : 'Telegram nije povezan sa nalogom')
    return false
  }
  const name = characterName
    ?? (job.character_id ? (await getCharacter(job.user_id, job.character_id))?.name : null)
    ?? 'karakter'
  const caption = photoPreviewCaption(job, name)
  const keyboard = photoApprovalKeyboard(job.id, job.attempt)
  try {
    let messageIds: number[]
    if (job.format === 'carousel') {
      const album = await sendMediaGroup(job.chat_id, slides.map((s, i) => ({ url: s.url, caption: i === 0 ? caption : undefined })))
      const buttons = await sendTextWithKeyboard(job.chat_id, `⬆️ Carousel (${slides.length} slajda, ovim redom) — odobri ceo set:`, keyboard) as { message_id?: number }
      messageIds = [...album.map(m => m.message_id), buttons?.message_id ?? 0].filter(Boolean)
    } else {
      const sent = await sendPhoto(job.chat_id, slides[0].url, caption, keyboard) as { message_id?: number }
      messageIds = sent?.message_id ? [sent.message_id] : []
    }
    await query(
      `UPDATE photo_replicator_jobs SET preview_message_ids = $2::jsonb, preview_sent_at = now(), updated_at = now()
        WHERE id = $1`,
      [job.id, JSON.stringify(messageIds)],
    )
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[photo-generate] job ${job.id} preview failed: ${msg}`)
    // The result is kept: Pošalji again re-sends this preview, nothing is generated.
    await query(
      `UPDATE photo_replicator_jobs
          SET status = 'failed', error = $2, error_code = 'PREVIEW_FAILED', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'awaiting_approval'`,
      [job.id, `Telegram: ${msg}`.slice(0, 1000)],
    )
    return false
  }
}
