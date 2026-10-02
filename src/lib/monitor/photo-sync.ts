/**
 * Photo Replicator phase 2 — the "Photo Replicator" tab as control plane.
 *
 * Every cron tick: a row with Pošalji (I) ticked becomes a photo job
 * (photo-jobs.ts), and every row's job is mirrored back into J–N. Only cells
 * that changed are written, always by address (never values:append, see
 * photo-sheet.ts), and only J–N plus the I checkbox — A–H belong to the
 * Clipper and the person. photo_replicator_jobs is the source of truth.
 *
 * Pošalji works as a button, like the Viral Sheet's: it is unticked as soon as
 * the row is handled. Ticking it again on a failed or rejected job is the
 * explicit retry; on a finished job with other E–H values it starts a new job.
 */
import { rows } from '@/lib/db'
import { RECREATE_SHEET_ID } from '@/lib/kling-recreate/sheet-config'
import { listCharacters, type ContentCharacter } from '@/lib/content-ops/characters'
import {
  MAX_CLAIMS_PER_TICK,
  a1Tab,
  columnLetter,
  googleSheetIO,
  isTicked,
  pickCharacter,
  resolveOwner,
  type CellValue,
  type SheetIO,
} from './viral-sheet'
import { PHOTO_COL, PHOTO_LAYOUT, PHOTO_TAB } from './photo-sheet'
import {
  FINAL_PHOTO_STATUSES,
  MAX_PHOTO_GENERATIONS,
  advancePhotoArchives,
  archivePhotoJob,
  createPhotoJob,
  findLivePhotoJob,
  getPhotoJob,
  loadPhotoJobs,
  parsePhotoFormat,
  parsePhotoSlides,
  photoSourceSha,
  queuePhotoOrFail,
  retryPhotoJob,
  type PhotoArchiveProgress,
  type PhotoErrorCode,
  type PhotoFormat,
  type PhotoJobRow,
} from './photo-jobs'
import { sendPhotoPreview } from './photo-generate'

export function photoSyncEnabled(): boolean {
  return process.env.PHOTO_REPLICATOR_SYNC_ENABLED === 'true'
}

export function photoStatusLabel(job: Pick<PhotoJobRow, 'status' | 'attempt'>): string {
  switch (job.status) {
    case 'queued': return '◷ U redu'
    case 'generating': return `● Generiše (pokušaj ${job.attempt}/${MAX_PHOTO_GENERATIONS})`
    case 'awaiting_approval': return '⏸ Čeka Approve (Telegram)'
    case 'approved': return '● Odobreno — ide na Drive'
    case 'archiving': return '● Upload na Drive'
    case 'archived': return '✓ Na Drive-u (raw)'
    case 'failed': return '⚠ Greška — čekiraj Pošalji za retry'
    case 'rejected': return '✖ Odbijeno — čekiraj Pošalji za novi job'
  }
}

/** Text for the Greška column: code first, so it can be filtered on (same shape as the Viral Sheet's). */
export function photoErrorText(code: PhotoErrorCode | null, message: string | null): string {
  return `${code ?? 'UNKNOWN_ERROR'}: ${(message ?? '').slice(0, 300)}`.trim()
}

export interface PhotoSyncResult {
  skipped?: string
  claimed: number
  retried: number
  resumed: number
  duplicates: number
  rejected: number
  cellsWritten: number
  archives?: PhotoArchiveProgress
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIVE = (s: PhotoJobRow['status']) => !FINAL_PHOTO_STATUSES.includes(s)

function a1(col: number, rowNumber: number): string {
  return `${a1Tab(PHOTO_TAB)}!${columnLetter(col)}${rowNumber}`
}

function setIfChanged(writes: Map<string, CellValue>, current: string, cell: string, desired: string): void {
  if (current !== desired) writes.set(cell, desired)
}

interface RowParams {
  character: ContentCharacter
  format: PhotoFormat
  slides: number
  addition: string | null
}

function sameParams(job: PhotoJobRow, p: RowParams): boolean {
  return job.character_id === p.character.id && job.format === p.format && job.slides === p.slides
    && (job.prompt_addition ?? null) === p.addition
}

/**
 * What the Farma column can honestly say: xxmachine only sees the farm's
 * repurpose order for this job (content-ops contract), not the copy onto a
 * phone. Delivery confirmation would need a farm → xxmachine callback.
 */
export async function photoFarmStatus(userId: string, jobs: PhotoJobRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const archived = jobs.filter(j => j.status === 'archived')
  if (!archived.length) return out
  const orders = await rows<{ photo_job_id: string; status: string; total_items: number; done_items: number }>(
    `SELECT DISTINCT ON (input->>'photoJobId') input->>'photoJobId' AS photo_job_id, status, total_items, done_items
       FROM generation_queue
      WHERE user_id = $1 AND job_type = 'content_ops_image_repurpose' AND input->>'photoJobId' = ANY($2::text[])
      ORDER BY input->>'photoJobId', created_at DESC`,
    [userId, archived.map(j => j.id)],
  )
  const byJob = new Map(orders.map(o => [o.photo_job_id, o]))
  for (const j of archived) {
    const o = byJob.get(j.id)
    out.set(j.id, !o ? '◷ Čeka farmu'
      : o.status === 'done' ? `✓ Farma: ${o.total_items} ${o.total_items === 1 ? 'varijanta spremna' : 'varijante spremne'} za uređaje`
        : o.status === 'failed' || o.status === 'cancelled' ? '⚠ Farma: priprema varijanti nije uspela'
          : `● Farma: priprema varijanti (${o.done_items}/${o.total_items})`)
  }
  return out
}

/** One cron tick of Photo Replicator: Drive archive progress, then the Sheet. */
export async function runPhotoReplicatorTick(io?: SheetIO): Promise<PhotoSyncResult> {
  if (!photoSyncEnabled()) return { skipped: 'disabled', claimed: 0, retried: 0, resumed: 0, duplicates: 0, rejected: 0, cellsWritten: 0 }
  // DB only — a Sheet outage must not hold up archives.
  const archives = await advancePhotoArchives()
  const result = await syncPhotoSheet(io ?? googleSheetIO(RECREATE_SHEET_ID, PHOTO_LAYOUT))
  return { ...result, archives }
}

export async function syncPhotoSheet(io: SheetIO): Promise<PhotoSyncResult> {
  const result: PhotoSyncResult = { claimed: 0, retried: 0, resumed: 0, duplicates: 0, rejected: 0, cellsWritten: 0 }
  if (!RECREATE_SHEET_ID) return { ...result, skipped: 'no_sheet' }
  const owner = await resolveOwner()
  if (!owner) return { ...result, skipped: 'no_owner' }

  const characters = (await listCharacters(owner.id)).filter(c => c.reference_image_url)
  const values = await io.readRows()
  const writes = new Map<string, CellValue>()

  const sheetRows = values.slice(1).map((cells, i) => {
    const get = (c: number) => String(cells[c] ?? '').trim()
    return {
      rowNumber: i + 2,
      image: get(PHOTO_COL.image),
      source: get(PHOTO_COL.source),
      character: get(PHOTO_COL.character),
      format: get(PHOTO_COL.format),
      slides: get(PHOTO_COL.slides),
      addition: get(PHOTO_COL.addition),
      send: isTicked(get(PHOTO_COL.send)),
      status: get(PHOTO_COL.status),
      jobId: get(PHOTO_COL.jobId),
      error: get(PHOTO_COL.error),
      result: get(PHOTO_COL.result),
      farm: get(PHOTO_COL.farm),
    }
  })

  const jobs = await loadPhotoJobs(owner.id, sheetRows.map(r => r.jobId).filter(id => UUID.test(id)))
  /** Final Job ID per row after this tick — drives the write-back. */
  const rowJob = new Map<number, string>()
  for (const r of sheetRows) if (jobs.has(r.jobId)) rowJob.set(r.rowNumber, r.jobId)
  /** Notes that must survive this tick's status write-back. */
  const notes = new Map<number, string>()

  const reject = (rowNumber: number, code: PhotoErrorCode, message: string) => {
    writes.set(a1(PHOTO_COL.send, rowNumber), false)
    writes.set(a1(PHOTO_COL.status, rowNumber), '⚠ Nije poslato')
    writes.set(a1(PHOTO_COL.error, rowNumber), photoErrorText(code, message))
    result.rejected++
    console.warn(`[photo-sync] row ${rowNumber} not sent [${code}]: ${message}`)
  }

  /** E–H of a row, or the reason they can't be used. */
  const paramsOf = (r: (typeof sheetRows)[number]): RowParams | string => {
    if (!r.character) return 'izaberi karakter u koloni E'
    const character = pickCharacter(characters, r.character)
    if (typeof character === 'string') return character
    if (!r.format) return 'izaberi Format u koloni F (Post, Story ili Carousel)'
    const format = parsePhotoFormat(r.format)
    if (!format) return `kolona F (Format) mora biti Post, Story ili Carousel, a ne "${r.format.slice(0, 20)}"`
    const slides = parsePhotoSlides(format, r.slides)
    if (typeof slides === 'string') return slides
    return { character, format, slides, addition: r.addition || null }
  }

  let claimsLeft = MAX_CLAIMS_PER_TICK

  /** New job for a row; false when the paid-claim budget for this tick is used up (row stays ticked). */
  const startNewJob = async (r: (typeof sheetRows)[number], p: RowParams, sha: string): Promise<boolean> => {
    if (claimsLeft <= 0) return false
    const created = await createPhotoJob({
      userId: owner.id,
      chatId: owner.telegram_chat_id,
      characterId: p.character.id,
      sourceUrl: r.image,
      sourceSha256: sha,
      sourceLink: r.source || null,
      format: p.format,
      slides: p.slides,
      promptAddition: p.addition,
      sheetRow: r.rowNumber,
    })
    writes.set(a1(PHOTO_COL.send, r.rowNumber), false)
    rowJob.set(r.rowNumber, created.jobId)
    if (created.created) {
      claimsLeft--
      await queuePhotoOrFail(owner.id, created.jobId)
      result.claimed++
    } else {
      notes.set(r.rowNumber, photoErrorText('DUPLICATE_JOB',
        `ista slika + karakter + format je već poslata (job ${created.jobId.slice(0, 8)}) — ovaj red prati taj job`))
      result.duplicates++
    }
    return true
  }

  for (const r of sheetRows.filter(row => row.send)) {
    const existing = jobs.get(r.jobId)
    const sha = r.image ? photoSourceSha(r.image, owner.id) : null
    const params = paramsOf(r)

    if (existing) {
      writes.set(a1(PHOTO_COL.send, r.rowNumber), false)
      const changed = typeof params !== 'string' && !sameParams(existing, params)

      if (ACTIVE(existing.status)) {
        notes.set(r.rowNumber, photoErrorText('DUPLICATE_JOB', changed
          ? 'job ovog reda je još u obradi — izmene u E–H važe za sledeći job, čekiraj ponovo kad se završi'
          : 'ovaj job je već u obradi'))
        result.duplicates++
        continue
      }
      // Finished job, other E–H: a new job for the new choice.
      if (changed && sha) {
        if (!(await startNewJob(r, params as RowParams, sha))) writes.delete(a1(PHOTO_COL.send, r.rowNumber))
        continue
      }
      if (existing.status === 'archived') {
        notes.set(r.rowNumber, photoErrorText('DUPLICATE_JOB',
          'već završeno i na Drive-u — promeni karakter, format, slajdove ili dodatak za novi job'))
        result.duplicates++
        continue
      }

      // failed / rejected with the same E–H: the explicit retry. Only one that
      // generates again counts against this tick's budget; resuming is free.
      const hasResult = Array.isArray(existing.result) && existing.result.length === existing.slides
      if ((existing.status === 'rejected' || !hasResult) && claimsLeft <= 0) {
        writes.delete(a1(PHOTO_COL.send, r.rowNumber))
        continue
      }
      const outcome = await retryPhotoJob(existing.id, owner.id)
      if (outcome === 'resumed_archive') {
        await archivePhotoJob(existing.id)
        result.resumed++
      } else if (outcome === 'resumed_preview') {
        const job = await getPhotoJob(existing.id, owner.id)
        if (job) await sendPhotoPreview(job)
        result.resumed++
      } else if (outcome === 'requeued') {
        claimsLeft--
        await queuePhotoOrFail(owner.id, existing.id)
        result.retried++
      } else if (outcome === 'new_job') {
        if (typeof params === 'string' || !sha) {
          notes.set(r.rowNumber, photoErrorText('INVALID_INPUT', typeof params === 'string' ? params : 'kolona A nije slika iz Photo Replicator-a'))
          result.rejected++
          continue
        }
        if (!(await startNewJob(r, params, sha))) writes.delete(a1(PHOTO_COL.send, r.rowNumber))
      } else if (outcome === 'duplicate') {
        const live = await findLivePhotoJob(owner.id, existing.id)
        if (live) {
          jobs.set(live.id, live)
          rowJob.set(r.rowNumber, live.id)
        }
        notes.set(r.rowNumber, photoErrorText('DUPLICATE_JOB', 'ista slika + karakter + format je već aktivna u drugom redu — ovaj red sada prati taj job'))
        result.duplicates++
      } else {
        notes.set(r.rowNumber, photoErrorText('INVALID_INPUT', 'ovaj job ne može da se ponovi'))
        result.rejected++
      }
      continue
    }

    // ── New row → new job.
    if (!r.image) { reject(r.rowNumber, 'INVALID_INPUT', 'kolona A nema sliku'); continue }
    if (!sha) { reject(r.rowNumber, 'INVALID_INPUT', 'kolona A nije slika koju je sačuvao Photo Replicator (Clipper)'); continue }
    if (typeof params === 'string') { reject(r.rowNumber, 'INVALID_INPUT', params); continue }
    if (!owner.telegram_chat_id) {
      reject(r.rowNumber, 'REPLICATOR_UNAVAILABLE', 'Telegram nije povezan sa nalogom — pregled nema gde da stigne na odobrenje')
      continue
    }
    await startNewJob(r, params, sha) // false: stays ticked for the next tick
  }

  // Re-read: jobs created, retried or resumed above show where they really are.
  const fresh = await loadPhotoJobs(owner.id, [...new Set(rowJob.values())])
  const farm = await photoFarmStatus(owner.id, [...fresh.values()])

  for (const r of sheetRows) {
    const jobId = rowJob.get(r.rowNumber)
    if (!jobId) {
      if (UUID.test(r.jobId) && r.status !== '⚠ Nepoznat Job ID') writes.set(a1(PHOTO_COL.status, r.rowNumber), '⚠ Nepoznat Job ID')
      continue
    }
    const job = fresh.get(jobId)
    if (!job) continue

    const jobError = job.status === 'failed' ? photoErrorText(job.error_code ?? 'UNKNOWN_ERROR', job.error ?? '') : ''
    // A duplicate note stays until the job it points at reports its own error.
    const keptNote = !jobError && r.error.startsWith('DUPLICATE_JOB') ? r.error : ''
    const desiredError = notes.get(r.rowNumber) ?? (jobError || keptNote)
    const slides = Array.isArray(job.result) && job.status !== 'rejected' ? job.result.map(s => s.url) : []

    setIfChanged(writes, r.status, a1(PHOTO_COL.status, r.rowNumber), photoStatusLabel(job))
    setIfChanged(writes, r.error, a1(PHOTO_COL.error, r.rowNumber), desiredError)
    setIfChanged(writes, r.result, a1(PHOTO_COL.result, r.rowNumber), slides.join('\n'))
    setIfChanged(writes, r.farm, a1(PHOTO_COL.farm, r.rowNumber), farm.get(job.id) ?? '')
    if (r.jobId !== jobId) writes.set(a1(PHOTO_COL.jobId, r.rowNumber), jobId)
  }

  const updates = [...writes].map(([cell, value]) => ({ a1: cell, value }))
  await io.writeCells(updates)
  result.cellsWritten = updates.length

  if (result.claimed || result.retried || result.resumed || result.duplicates || result.rejected) {
    console.log(`[photo-sync] claimed ${result.claimed}, retried ${result.retried}, resumed ${result.resumed}, duplicates ${result.duplicates}, rejected ${result.rejected}, cells ${result.cellsWritten}`)
  }
  return result
}

