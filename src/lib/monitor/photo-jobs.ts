/**
 * Photo Replicator phase 2 — the job model (migration 106).
 *
 * One ticked row of the "Photo Replicator" tab becomes one photo_replicator_jobs
 * row; the table is the source of truth and the Sheet only mirrors it
 * (photo-sync.ts). The paid part (photo-generate.ts) runs only from 'queued',
 * once per claim; everything after a generation — the Telegram preview, the
 * approval, the Drive archive — can be repeated without paying again.
 *
 * queued → generating → awaiting_approval ─ Approve → approved → archiving → archived
 *                ↑               │
 *                └─ Regenerate ──┤  (at most MAX_PHOTO_GENERATIONS per job)
 *                                └─ Reject → rejected
 */
import { one, query, rows } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'
import { IGREPLICATOR_DRIVE_SECTION } from '@/lib/drive-archive/paths'
import type { ContentFormat } from '@/lib/drive-archive/content-format'
import { characterDriveKey, getCharacter } from '@/lib/content-ops/characters'

export type PhotoJobStatus =
  | 'queued' | 'generating' | 'awaiting_approval' | 'approved' | 'archiving' | 'archived'
  | 'failed' | 'rejected'

export type PhotoFormat = 'post' | 'story' | 'carousel'

export type PhotoErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_JOB'
  | 'GENERATION_FAILED'
  | 'STORAGE_FAILED'
  | 'PREVIEW_FAILED'
  | 'REGEN_LIMIT'
  | 'QUEUE_FAILED'
  | 'DRIVE_UNAVAILABLE'
  | 'DRIVE_FAILED'
  | 'REPLICATOR_UNAVAILABLE'
  | 'STALLED'
  | 'UNKNOWN_ERROR'

/** Generations one job may start, Regenerate included. */
export const MAX_PHOTO_GENERATIONS = 3

/** Carousel slides when the Slajdova column is left empty. */
export const DEFAULT_CAROUSEL_SLIDES = 3

export interface PhotoSlide {
  url: string
  prompt: string
}

export interface PhotoJobRow {
  id: string
  user_id: string
  chat_id: string | null
  character_id: string | null
  source_url: string
  source_sha256: string
  source_link: string | null
  resolved_source_url: string | null
  source_note: string | null
  format: PhotoFormat
  slides: number
  prompt_addition: string | null
  prompt: string | null
  sheet_row: number | null
  status: PhotoJobStatus
  attempt: number
  result: PhotoSlide[] | null
  preview_message_ids: number[] | null
  preview_sent_at: string | null
  approved_at: string | null
  archived_at: string | null
  error_code: PhotoErrorCode | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

/** Statuses a job does not leave on its own. */
export const FINAL_PHOTO_STATUSES: readonly PhotoJobStatus[] = ['archived', 'failed', 'rejected']

const FORMAT_BY_LABEL: Record<string, PhotoFormat> = { post: 'post', story: 'story', carousel: 'carousel' }

/** The Format column (Post / Story / Carousel), case-insensitive. */
export function parsePhotoFormat(raw: string): PhotoFormat | null {
  return FORMAT_BY_LABEL[raw.trim().toLowerCase()] ?? null
}

/** The Slajdova column: 2 or 3 for a carousel (empty = 3), always 1 otherwise. A string is the reason it can't be used. */
export function parsePhotoSlides(format: PhotoFormat, raw: string): number | string {
  if (format !== 'carousel') return 1
  const s = raw.trim()
  if (!s) return DEFAULT_CAROUSEL_SLIDES
  if (s === '2' || s === '3') return Number(s)
  return `kolona G (Slajdova) mora biti 2 ili 3 za Carousel, a ne "${s.slice(0, 20)}"`
}

/** Drive folder kind for each format: XXMachine Archives/IGreplicator/<character>/<Post|stories|carousel>/… */
export const PHOTO_DRIVE_KIND: Record<PhotoFormat, ContentFormat> = {
  post: 'posts',
  story: 'stories',
  carousel: 'carousels',
}

const SOURCE_PATH = /\/photo-replicator\/([0-9a-f-]{36})\/([0-9a-f]{64})\.(jpg|png|webp)$/i

/**
 * The sha256 of a Phase 1 photo, read from its storage URL — only for a photo
 * the Clipper stored for this user. Anything else typed into column A is refused.
 */
export function photoSourceSha(url: string, userId: string): string | null {
  try {
    const m = new URL(url.trim()).pathname.match(SOURCE_PATH)
    if (!m || m[1].toLowerCase() !== userId.toLowerCase()) return null
    return m[2].toLowerCase()
  } catch {
    return null
  }
}

/** Short id for file and folder names — the first 8 hex chars of the job id. */
export function photoJobShort(jobId: string): string {
  return jobId.replace(/-/g, '').slice(0, 8)
}

/** Drive set folder of a carousel, e.g. pr_1a2b3c4d_3s — the farm reads the slide count from the suffix. */
export function photoSeriesFolder(job: Pick<PhotoJobRow, 'id' | 'format' | 'slides'>): string | null {
  return job.format === 'carousel' ? `pr_${photoJobShort(job.id)}_${job.slides}s` : null
}

export async function getPhotoJob(jobId: string, userId?: string): Promise<PhotoJobRow | null> {
  return await one<PhotoJobRow>(
    `SELECT * FROM photo_replicator_jobs WHERE id = $1 ${userId ? 'AND user_id = $2' : ''}`,
    userId ? [jobId, userId] : [jobId],
  )
}

export async function loadPhotoJobs(userId: string, ids: string[]): Promise<Map<string, PhotoJobRow>> {
  if (!ids.length) return new Map()
  const found = await rows<PhotoJobRow>(
    `SELECT * FROM photo_replicator_jobs WHERE id = ANY($1::uuid[]) AND user_id = $2`,
    [ids, userId],
  )
  return new Map(found.map(j => [j.id, j]))
}

export interface CreatePhotoJobInput {
  userId: string
  chatId: string | number | null
  characterId: string
  sourceUrl: string
  sourceSha256: string
  sourceLink: string | null
  format: PhotoFormat
  slides: number
  promptAddition: string | null
  sheetRow: number | null
}

export interface CreatePhotoJobResult {
  jobId: string
  /** false: the same photo + character + format + slides + addition was already live — jobId is that job. */
  created: boolean
  status: PhotoJobStatus
}

/**
 * One ticked row → one 'queued' job. The partial unique index from migration
 * 106 is the duplicate guard: two ticks racing on the same row, or two rows
 * asking for the same thing, end up with one job.
 */
export async function createPhotoJob(opts: CreatePhotoJobInput): Promise<CreatePhotoJobResult> {
  const addition = opts.promptAddition?.trim() || null
  const inserted = await one<{ id: string }>(
    `INSERT INTO photo_replicator_jobs
       (user_id, chat_id, character_id, source_url, source_sha256, source_link, format, slides, prompt_addition, sheet_row)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, source_sha256, character_id, format, slides, md5(coalesce(prompt_addition, '')))
       WHERE status NOT IN ('failed', 'rejected')
     DO NOTHING
     RETURNING id`,
    [
      opts.userId, opts.chatId != null ? String(opts.chatId) : null, opts.characterId,
      opts.sourceUrl, opts.sourceSha256, opts.sourceLink, opts.format, opts.slides, addition, opts.sheetRow,
    ],
  )
  if (inserted) {
    console.log(`[photo-jobs] job ${inserted.id} queued (${opts.format}${opts.format === 'carousel' ? ` ×${opts.slides}` : ''}, character ${opts.characterId})`)
    return { jobId: inserted.id, created: true, status: 'queued' }
  }
  const existing = await one<{ id: string; status: PhotoJobStatus }>(
    `SELECT id, status FROM photo_replicator_jobs
      WHERE user_id = $1 AND source_sha256 = $2 AND character_id = $3 AND format = $4 AND slides = $5
        AND md5(coalesce(prompt_addition, '')) = md5(coalesce($6::text, ''))
        AND status NOT IN ('failed', 'rejected')
      LIMIT 1`,
    [opts.userId, opts.sourceSha256, opts.characterId, opts.format, opts.slides, addition],
  )
  // Only if the conflicting job ended in the instant between the two statements;
  // the row stays ticked and the next tick tries again.
  if (!existing) throw new Error('Conflicting photo job disappeared before it could be read — will retry next tick')
  return { jobId: existing.id, created: false, status: existing.status }
}

export type PhotoRetryOutcome =
  /** Approved result re-sent to Drive — nothing generated. */
  | 'resumed_archive'
  /** Unapproved result shown in Telegram again — nothing generated. */
  | 'resumed_preview'
  /** No result yet and generations left: the same job generates again. */
  | 'requeued'
  /** Nothing to resume on this job (rejected, or out of generations): start a new one. */
  | 'new_job'
  /** Meanwhile another row made the same thing live. */
  | 'duplicate'
  | 'not_retryable'

/**
 * Explicit retry from the Sheet (Pošalji ticked again on a failed or rejected
 * job). A paid generation is repeated only when the job has no result at all.
 */
export async function retryPhotoJob(jobId: string, userId: string): Promise<PhotoRetryOutcome> {
  const job = await getPhotoJob(jobId, userId)
  if (!job) return 'not_retryable'
  if (job.status === 'rejected') return 'new_job'
  if (job.status !== 'failed') return 'not_retryable'

  const hasResult = Array.isArray(job.result) && job.result.length === job.slides
  const next: { status: PhotoJobStatus; outcome: PhotoRetryOutcome } | null =
    hasResult && job.approved_at ? { status: 'approved', outcome: 'resumed_archive' }
      : hasResult ? { status: 'awaiting_approval', outcome: 'resumed_preview' }
        : job.attempt < MAX_PHOTO_GENERATIONS ? { status: 'queued', outcome: 'requeued' }
          : null
  if (!next) return 'new_job'

  try {
    const row = await one<{ id: string }>(
      `UPDATE photo_replicator_jobs
          SET status = $3, error = NULL, error_code = NULL, completed_at = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'failed'
        RETURNING id`,
      [jobId, userId, next.status],
    )
    if (!row) return 'not_retryable'
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return 'duplicate'
    throw err
  }
  console.log(`[photo-jobs] job ${jobId} retried → ${next.status}`)
  return next.outcome
}

export async function markPhotoJobFailed(jobId: string, code: PhotoErrorCode, msg: string): Promise<void> {
  await query(
    `UPDATE photo_replicator_jobs
        SET status = 'failed', error = $2, error_code = $3, completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [jobId, msg.slice(0, 1000), code],
  )
}

/** The live job that blocked a retry of `failedJobId` (same photo + character + format + slides + addition). */
export async function findLivePhotoJob(userId: string, failedJobId: string): Promise<PhotoJobRow | null> {
  return await one<PhotoJobRow>(
    `SELECT live.* FROM photo_replicator_jobs old
       JOIN photo_replicator_jobs live
         ON live.user_id = old.user_id AND live.source_sha256 = old.source_sha256
        AND live.character_id = old.character_id AND live.format = old.format AND live.slides = old.slides
        AND md5(coalesce(live.prompt_addition, '')) = md5(coalesce(old.prompt_addition, ''))
        AND live.status NOT IN ('failed', 'rejected')
      WHERE old.id = $1 AND old.user_id = $2
      LIMIT 1`,
    [failedJobId, userId],
  )
}

// ── Queue ────────────────────────────────────────────────────────────────────

/**
 * One generation_queue job for one generation, started right away (the same
 * claim-then-kick pattern as queueCopyPasteWan). max_attempts = 1: a worker
 * that dies mid-call is never re-run blind — the stale sweep fails it and a
 * person decides (cron/tick).
 */
export async function queuePhotoGeneration(userId: string, jobId: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items, max_attempts)
     VALUES ($1, 'photo_replicator', $2, 1, 1)
     RETURNING id`,
    [userId, JSON.stringify({ photoJobId: jobId })],
  )
  if (!row) throw new Error('Queue insert returned no row')
  const secret = process.env.CRON_SECRET
  if (secret) {
    const claimed = await one<{ id: string }>(
      `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
        WHERE id=$1 AND status='pending' RETURNING id`,
      [row.id],
    ).catch(() => null)
    if (claimed) {
      fetch(`${internalBaseUrl()}/api/queue/process/${row.id}`, {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      }).catch(err => console.error('[photo-jobs] fire photo_replicator worker:', err))
    }
  }
  return row.id
}

/** Queues the generation of a 'queued' job; a queue that can't take it fails the job visibly. */
export async function queuePhotoOrFail(userId: string, jobId: string): Promise<boolean> {
  try {
    await queuePhotoGeneration(userId, jobId)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[photo-jobs] queue failed for job ${jobId}:`, msg)
    await markPhotoJobFailed(jobId, 'QUEUE_FAILED', `Queue: ${msg}`)
    return false
  }
}

/**
 * cron/tick fails a stalled photo_replicator queue job; this fails the photo
 * job it left in 'generating'. No result means nothing reached Telegram, so a
 * re-tick generates again (it may already have been billed — the error says so).
 */
export async function failStalePhotoJob(queueJobId: string, message: string): Promise<number> {
  const res = await query(
    `UPDATE photo_replicator_jobs p
        SET status = 'failed', error = $2, error_code = 'STALLED', completed_at = now(), updated_at = now()
       FROM generation_queue g
      WHERE g.id = $1 AND p.id::text = g.input->>'photoJobId' AND p.status = 'generating'`,
    [queueJobId, message],
  )
  const n = res.rowCount ?? 0
  if (n) console.error(`[photo-jobs] queue job ${queueJobId} stalled — photo job failed`)
  return n
}

// ── Drive raw archive (after Approve) ───────────────────────────────────────

export type PhotoArchiveOutcome = 'archiving' | 'unavailable' | 'not_approved'

/**
 * Approved result → Drive raw, in slide order:
 *   XXMachine Archives/IGreplicator/<character>/<Post|stories|carousel>/raw/<YYYY-MM-DD>/
 * A carousel gets its own set folder pr_<job8>_<n>s (files 01_…, 02_…, …); a
 * post or story is one file pr_<job8>_01_….jpg. Idempotent: drive_exports is
 * unique per (source, url), so calling this again only re-queues what is missing
 * or what failed for good.
 */
export async function archivePhotoJob(jobId: string): Promise<PhotoArchiveOutcome> {
  const job = await getPhotoJob(jobId)
  if (!job || (job.status !== 'approved' && job.status !== 'archiving') || !job.approved_at) return 'not_approved'
  const slides = Array.isArray(job.result) ? job.result : []
  if (slides.length !== job.slides) {
    await markPhotoJobFailed(jobId, 'UNKNOWN_ERROR', `Approved result has ${slides.length} of ${job.slides} slides`)
    return 'unavailable'
  }
  const character = job.character_id ? await getCharacter(job.user_id, job.character_id) : null
  if (!character) {
    await markPhotoJobFailed(jobId, 'INVALID_INPUT', 'Karakter više ne postoji u xxmachine — Drive folder nije poznat')
    return 'unavailable'
  }

  // A file that failed for good (or was skipped while auto-archive was off) is retried from zero.
  await query(
    `UPDATE drive_exports
        SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = now(), finished_at = NULL
      WHERE user_id = $1 AND source_type = 'photo_replicator' AND source_id = $2
        AND (status = 'skipped' OR (status = 'failed' AND finished_at IS NOT NULL))`,
    [job.user_id, job.id],
  )
  const enqueued = await enqueueDriveArchive({
    userId: job.user_id,
    sourceType: 'photo_replicator',
    sourceId: job.id,
    urls: slides.map(s => s.url),
    characterKey: characterDriveKey(character.name),
    kind: PHOTO_DRIVE_KIND[job.format],
    stage: 'raw',
    modelKey: 'photo_replicator',
    seriesLabel: job.format === 'carousel' ? null : `pr_${photoJobShort(job.id)}`,
    seriesFolder: photoSeriesFolder(job),
    section: IGREPLICATOR_DRIVE_SECTION,
  })
  if (enqueued.reason === 'auto_archive_off' || enqueued.reason === 'not_connected' || enqueued.reason === 'user_not_found') {
    await markPhotoJobFailed(jobId, 'DRIVE_UNAVAILABLE',
      enqueued.reason === 'auto_archive_off' ? 'Drive auto-archive je isključen' : 'Google Drive nije povezan')
    return 'unavailable'
  }
  await query(
    `UPDATE photo_replicator_jobs SET status = 'archiving', updated_at = now()
      WHERE id = $1 AND status = 'approved'`,
    [jobId],
  )
  console.log(`[photo-jobs] job ${jobId} → Drive raw (${enqueued.enqueued} new file(s) of ${slides.length})`)
  return 'archiving'
}

export interface PhotoArchiveProgress {
  archived: number
  failed: number
  resumed: number
}

/**
 * Moves archiving jobs on from their drive_exports rows (cron/tick):
 * every slide uploaded → archived; a slide failed for good → failed DRIVE_FAILED
 * (re-tick re-archives, nothing is generated). Also finishes an approval whose
 * archive step never ran (a crash between Approve and the enqueue).
 */
export async function advancePhotoArchives(): Promise<PhotoArchiveProgress> {
  const out: PhotoArchiveProgress = { archived: 0, failed: 0, resumed: 0 }

  const stuckApproved = await rows<{ id: string }>(
    `SELECT id FROM photo_replicator_jobs
      WHERE status = 'approved' AND updated_at < now() - interval '2 minutes'
      ORDER BY updated_at LIMIT 10`,
  )
  for (const j of stuckApproved) {
    if (await archivePhotoJob(j.id).catch(() => 'unavailable') === 'archiving') out.resumed++
  }

  const progress = await rows<{ id: string; slides: number; total: number; done: number; skipped: number; dead: number }>(
    `SELECT j.id, j.slides,
            count(e.id)::int AS total,
            count(e.id) FILTER (WHERE e.status = 'done')::int AS done,
            count(e.id) FILTER (WHERE e.status = 'skipped')::int AS skipped,
            count(e.id) FILTER (WHERE e.status = 'failed' AND e.finished_at IS NOT NULL)::int AS dead
       FROM photo_replicator_jobs j
       LEFT JOIN drive_exports e
         ON e.user_id = j.user_id AND e.source_type = 'photo_replicator' AND e.source_id = j.id::text
      WHERE j.status = 'archiving'
      GROUP BY j.id, j.slides`,
  )
  for (const p of progress) {
    if (p.total >= p.slides && p.done === p.total) {
      const done = await query(
        `UPDATE photo_replicator_jobs
            SET status = 'archived', archived_at = now(), completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'archiving'`,
        [p.id],
      )
      if (done.rowCount) {
        out.archived++
        console.log(`[photo-jobs] job ${p.id} archived to Drive raw (${p.done} file(s))`)
      }
    } else if (p.dead || p.skipped) {
      await markPhotoJobFailed(p.id, p.dead ? 'DRIVE_FAILED' : 'DRIVE_UNAVAILABLE',
        p.dead ? `${p.dead} fajl(a) nije otpremljeno na Drive posle svih pokušaja — čekiraj Pošalji za ponovni upload`
          : 'Drive auto-archive je isključen — fajlovi nisu otpremljeni')
      out.failed++
    } else if (p.total === 0) {
      // Nothing was ever queued for it — queue it now.
      if (await archivePhotoJob(p.id).catch(() => 'unavailable') === 'archiving') out.resumed++
    }
  }
  return out
}
