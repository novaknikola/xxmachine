/**
 * Photo Replicator phase 2E — the farm's image repurpose (content-ops contract).
 *
 * The farm finds an approved photo on Drive raw (a post/story file, or a
 * complete carousel set folder) and orders one variant per farm account of
 * that character. Each variant is the same ffmpeg uniqueness pass the archive
 * already uses for images (drive-archive/image-repurpose.ts); every slide of a
 * set gets the SAME seed for a given target, so a carousel stays one coherent
 * set (flipped together, same crop/colour) while different targets differ.
 *
 * Sources: a file the archive uploaded for a photo job is read from our own
 * storage copy (drive_exports.source_url, durable, no Drive call); anything
 * else is downloaded from Drive with the owner's Google token.
 */
import { createHash, randomInt } from 'node:crypto'
import { one, query, rows } from '@/lib/db'
import { uploadBuffer } from '@/lib/supabase-storage'
import { downloadDriveFile } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'
import { repurposeImageBuffer } from '@/lib/drive-archive/image-repurpose'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'
import { IGREPLICATOR_DRIVE_SECTION, sanitizeArchiveLabel, sanitizeDriveKey } from '@/lib/drive-archive/paths'
import type { ContentFormat } from '@/lib/drive-archive/content-format'

export type FarmImageFormat = 'post' | 'story' | 'carousel'

export const FARM_IMAGE_FORMATS: Record<FarmImageFormat, ContentFormat> = {
  post: 'posts',
  story: 'stories',
  carousel: 'carousels',
}

export const MAX_FARM_IMAGE_VARIANTS = 20
/** Instagram allows 20 slides; Photo Replicator makes at most 3, the contract allows up to 10. */
export const MAX_FARM_IMAGE_SLIDES = 10

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/

export interface FarmImageSlide {
  driveFileId: string
  /** Our storage copy, when the archive uploaded this file; otherwise null and it is read from Drive. */
  sourceUrl: string | null
}

export interface FarmImageRepurposeInput {
  orderKey: string
  /** The photo job the files came from, when they all came from one. */
  photoJobId: string | null
  format: FarmImageFormat
  count: number
  slides: FarmImageSlide[]
  baseSeed: number
  characterKey: string | null
  setName: string
  /** Variants are also archived to Drive ready/, like the farm's video repurpose. */
  archiveToDrive: boolean
}

export class FarmImageOrderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Same files in the same slide order + format + count → the same order (a re-sent request reuses the job). */
export function farmImageOrderKey(format: FarmImageFormat, count: number, driveFileIds: string[]): string {
  return createHash('sha256').update(`${format}|${count}|${driveFileIds.join(',')}`).digest('hex')
}

export async function orderFarmImageRepurpose(userId: string, body: {
  driveFileIds?: unknown
  format?: unknown
  count?: unknown
  characterKey?: unknown
  setName?: unknown
} | null): Promise<{ jobId: string; count: number; slides: number; photoJobId: string | null; reused: boolean }> {
  const ids = Array.isArray(body?.driveFileIds) ? body.driveFileIds.map(v => (typeof v === 'string' ? v.trim() : '')) : []
  if (!ids.length || ids.length > MAX_FARM_IMAGE_SLIDES || ids.some(id => !DRIVE_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new FarmImageOrderError(400, `driveFileIds must be 1-${MAX_FARM_IMAGE_SLIDES} distinct Drive ids, in slide order`)
  }
  const format = typeof body?.format === 'string' ? body.format.trim().toLowerCase() as FarmImageFormat : null
  if (!format || !(format in FARM_IMAGE_FORMATS)) throw new FarmImageOrderError(400, 'format must be post, story or carousel')
  if (format !== 'carousel' && ids.length !== 1) throw new FarmImageOrderError(400, `a ${format} is exactly one file`)
  if (format === 'carousel' && ids.length < 2) throw new FarmImageOrderError(400, 'a carousel needs at least 2 files')
  const count = Number(body?.count)
  if (!Number.isInteger(count) || count < 1 || count > MAX_FARM_IMAGE_VARIANTS) {
    throw new FarmImageOrderError(400, `count must be 1-${MAX_FARM_IMAGE_VARIANTS}`)
  }
  const characterKey = typeof body?.characterKey === 'string' && body.characterKey.trim() ? sanitizeDriveKey(body.characterKey) : null

  const orderKey = farmImageOrderKey(format, count, ids)
  const existing = await one<{ id: string; input: FarmImageRepurposeInput }>(
    `SELECT id, input FROM generation_queue
      WHERE user_id = $1 AND job_type = 'content_ops_image_repurpose' AND input->>'orderKey' = $2
        AND status NOT IN ('failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1`,
    [userId, orderKey],
  )
  if (existing) {
    return { jobId: existing.id, count, slides: ids.length, photoJobId: existing.input.photoJobId ?? null, reused: true }
  }

  const archived = await rows<{ drive_file_id: string; source_type: string; source_id: string; source_url: string }>(
    `SELECT DISTINCT ON (drive_file_id) drive_file_id, source_type, source_id, source_url
       FROM drive_exports
      WHERE user_id = $1 AND drive_file_id = ANY($2::text[]) AND status = 'done'
      ORDER BY drive_file_id, finished_at DESC NULLS LAST`,
    [userId, ids],
  )
  const byId = new Map(archived.map(a => [a.drive_file_id, a]))
  const slides: FarmImageSlide[] = ids.map(id => ({ driveFileId: id, sourceUrl: byId.get(id)?.source_url ?? null }))
  const photoJobs = new Set(ids.map(id => {
    const a = byId.get(id)
    return a?.source_type === 'photo_replicator' ? a.source_id : null
  }))
  const photoJobId = photoJobs.size === 1 ? [...photoJobs][0] : null

  const setName = sanitizeArchiveLabel(typeof body?.setName === 'string' ? body.setName : '')
    || (photoJobId ? `pr_${photoJobId.replace(/-/g, '').slice(0, 8)}` : `farm_${orderKey.slice(0, 8)}`)
  const input: FarmImageRepurposeInput = {
    orderKey,
    photoJobId,
    format,
    count,
    slides,
    baseSeed: randomInt(0, 0x7fffffff),
    characterKey,
    setName,
    archiveToDrive: true,
  }
  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'content_ops_image_repurpose', $2, $3)
     RETURNING id`,
    [userId, JSON.stringify(input), count],
  )
  if (!row) throw new FarmImageOrderError(500, 'Could not queue the job')
  console.log(`[content-ops] image repurpose ${row.id}: ${format} ×${ids.length} → ${count} variant(s)${photoJobId ? ` (photo job ${photoJobId})` : ''}`)
  return { jobId: row.id, count, slides: ids.length, photoJobId, reused: false }
}

/** Seed of target `t` — shared by every slide of that target's set. */
export function farmTargetSeed(baseSeed: number, target: number): number {
  return (baseSeed + target * 1337) >>> 0
}

/** Each slide's URL for ffmpeg, made once per job: our copy, or the Drive file stored under the job. */
async function slideSources(queueJobId: string, userId: string, slides: FarmImageSlide[]): Promise<string[]> {
  const out: string[] = []
  let token: string | null = null
  for (const [i, s] of slides.entries()) {
    if (s.sourceUrl) { out.push(s.sourceUrl); continue }
    token ??= await getUserGoogleAccessToken(userId)
    const buf = await downloadDriveFile(s.driveFileId, token)
    out.push(await uploadBuffer(buf, `content-ops/${queueJobId}/source_${i + 1}.jpg`, 'image/jpeg'))
  }
  return out
}

export type FarmImageSet = string[] | string

/**
 * The worker (queue branch content_ops_image_repurpose). Resumes from
 * done_items; a target whose render fails stays in the list as "error:<reason>"
 * so set i always belongs to target i. Never paid — ffmpeg on the VPS.
 */
export async function runFarmImageRepurpose(opts: {
  queueJobId: string
  userId: string
  input: FarmImageRepurposeInput
  previous: FarmImageSet[]
  doneItems: number
  stillRunning: () => Promise<boolean>
}): Promise<{ sets: FarmImageSet[]; cancelled: boolean }> {
  const { queueJobId, userId, input } = opts
  const sets: FarmImageSet[] = [...opts.previous]
  const sources = await slideSources(queueJobId, userId, input.slides)
  const kind = FARM_IMAGE_FORMATS[input.format]

  for (let t = opts.doneItems; t < input.count; t++) {
    if (!(await opts.stillRunning())) return { sets, cancelled: true }
    const seed = farmTargetSeed(input.baseSeed, t)
    try {
      const urls: string[] = []
      for (const [s, src] of sources.entries()) {
        const buf = await repurposeImageBuffer(src, kind, seed, 'dedupe')
        urls.push(await uploadBuffer(buf, `content-ops/${queueJobId}/t${t + 1}_s${s + 1}.jpg`, 'image/jpeg'))
      }
      sets[t] = urls
      if (input.archiveToDrive && input.characterKey) {
        const label = `${input.setName}_t${t + 1}`
        await enqueueDriveArchive({
          userId,
          sourceType: 'queue_job',
          sourceId: `${queueJobId}:t${t + 1}`,
          urls,
          characterKey: input.characterKey,
          kind,
          stage: 'ready',
          modelKey: 'farm_repurpose',
          seriesLabel: input.format === 'carousel' ? null : label,
          seriesFolder: input.format === 'carousel' ? `${label}_${urls.length}s` : null,
          section: IGREPLICATOR_DRIVE_SECTION,
        }).catch(err => console.error(`[content-ops] image repurpose ${queueJobId} t${t + 1} ready/ archive:`, err))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[content-ops] image repurpose ${queueJobId} target ${t + 1} failed:`, msg)
      sets[t] = `error:${msg.slice(0, 200)}`
    }
    await query(
      `UPDATE generation_queue
          SET done_items = $2, progress = $3, output = jsonb_build_object('sets', $4::jsonb, 'progressAt', $5::text)
        WHERE id = $1`,
      [queueJobId, t + 1, Math.round(((t + 1) / input.count) * 100), JSON.stringify(sets), new Date().toISOString()],
    )
  }
  return { sets, cancelled: false }
}

export async function farmImageRepurposeStatus(userId: string, jobId: string) {
  const job = await one<{ status: string; total_items: number; done_items: number; output: { sets?: FarmImageSet[] } | null; error: string | null; input: FarmImageRepurposeInput }>(
    `SELECT status, total_items, done_items, output, error, input
       FROM generation_queue
      WHERE id = $1 AND user_id = $2 AND job_type = 'content_ops_image_repurpose'`,
    [jobId, userId],
  )
  if (!job) return null
  return {
    status: job.status,
    total: job.total_items,
    done: job.done_items,
    format: job.input.format,
    slides: job.input.slides.length,
    sets: job.output?.sets ?? [],
    error: job.error,
  }
}
