/**
 * "Viral monitoring" Sheet → IG Replicator bridge.
 *
 * Tab `Sheet1` of RECREATE_SHEET_ID is where the IG Outlier browser extension's
 * Apps Script writes every scored reel (columns A–I). Columns J–P belong to this
 * module: the user picks a character (J) and ticks "Pošalji" (K); every cron
 * tick turns ticked rows into copy_paste_wan_jobs (origin 'sheet') and writes
 * each job's status back (L–P). Same service-account pattern as the recreate
 * bot's Bulk Queue tab (kling-recreate/bulk-sheet.ts) — no new auth.
 *
 * The tick is the only writer of J–P besides the user, and K works as a button:
 * it is unticked as soon as the row is handled. Ticking it again on a failed or
 * cancelled job is the explicit retry.
 */
import { one, rows } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { RECREATE_SHEET_ID } from '@/lib/kling-recreate/sheet-config'
import { composeStillPrompt, listCharacters, type ContentCharacter } from '@/lib/content-ops/characters'
import { parseReelUrl } from './parse-reel-url'
import {
  createSheetWanJob,
  markWanJobFailed,
  retrySheetWanJob,
  type WanErrorCode,
  type WanJobStatus,
} from './wan-jobs'
import { queueCopyPasteWan } from './wan-queue'

export const VIRAL_TAB = 'Sheet1'
export const BRIDGE_HEADERS = ['Karakter', 'Pošalji', 'Replicator status', 'Job ID', 'Greška', 'Pregledi', 'Rezultat']

/** 0-based column indexes in an A–P row. */
const COL = { account: 0, url: 1, character: 9, send: 10, status: 11, jobId: 12, error: 13, views: 14, result: 15 } as const
const FIRST_BRIDGE_COL = COL.character

/**
 * Same cap as the Bulk Queue: a careless select-all of the checkbox column must
 * not start dozens of paid stills in one minute. The rest stay ticked and go on
 * the following ticks.
 */
export const MAX_CLAIMS_PER_TICK = 5

/** How often the character dropdown / checkbox rules are re-applied (rows appended since get them too). */
const VALIDATION_REFRESH_MS = 10 * 60_000

export const STATUS_LABEL: Record<WanJobStatus, string> = {
  queued: '◷ U redu',
  acquiring: '● Preuzimanje videa',
  awaiting_confirm: '● Priprema stilla',
  still_generating: '● Pravi still',
  awaiting_approval: '⏸ Čeka Approve (Telegram)',
  approved: '● Generiše video',
  generating: '● Generiše video',
  done: '✓ Završeno',
  failed: '⚠ Greška — čekiraj Pošalji za retry',
  cancelled: '✖ Otkazano — čekiraj Pošalji za retry',
}

export type CellValue = string | number | boolean

/** The Sheet as this module needs it — swapped for an in-memory one in tests. */
export interface SheetIO {
  /** A1:P of the tab, header row included, formatted values (a ticked checkbox reads "TRUE"). */
  readRows(): Promise<string[][]>
  writeCells(updates: { a1: string; value: CellValue }[]): Promise<void>
  /** Dropdown of character names on J, checkboxes on K, from row 2 down. */
  applyValidation(characterNames: string[]): Promise<void>
}

export interface ViralSheetSyncResult {
  skipped?: string
  claimed: number
  retried: number
  duplicates: number
  rejected: number
  cellsWritten: number
}

interface SheetJob {
  id: string
  status: WanJobStatus
  error: string | null
  error_code: WanErrorCode | null
  video_result_url: string | null
  views: number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function columnLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index)
}

function a1(col: number, rowNumber: number): string {
  return `${VIRAL_TAB}!${columnLetter(col)}${rowNumber}`
}

export function isTicked(raw: string): boolean {
  return raw.trim().toUpperCase() === 'TRUE'
}

/** Text for the "Greška" column: code first, so it can be filtered on. */
export function errorText(code: WanErrorCode | null, message: string | null): string {
  return `${code ?? 'UNKNOWN_ERROR'}: ${(message ?? '').slice(0, 300)}`.trim()
}

/** The owner account — its Telegram gets the stills, its characters fill the dropdown. */
export async function resolveOwner(): Promise<{ id: string; telegram_chat_id: string | null } | null> {
  const email = process.env.OWNER_EMAIL
  if (!email) return null
  return await one<{ id: string; telegram_chat_id: string | null }>(
    `SELECT id, telegram_chat_id::text AS telegram_chat_id FROM users WHERE email = $1 AND active LIMIT 1`,
    [email],
  )
}

let lastValidation: { key: string; at: number } | null = null

export async function syncViralSheet(io: SheetIO = googleSheetIO()): Promise<ViralSheetSyncResult> {
  const result: ViralSheetSyncResult = { claimed: 0, retried: 0, duplicates: 0, rejected: 0, cellsWritten: 0 }
  if (!RECREATE_SHEET_ID) return { ...result, skipped: 'no_sheet' }

  const owner = await resolveOwner()
  if (!owner) return { ...result, skipped: 'no_owner' }

  const characters = (await listCharacters(owner.id)).filter(c => c.reference_image_url)
  const values = await io.readRows()

  // Row 1: bridge headers next to the extension's own nine.
  const writes = new Map<string, CellValue>()
  const header = values[0] ?? []
  BRIDGE_HEADERS.forEach((h, i) => {
    if ((header[FIRST_BRIDGE_COL + i] ?? '') !== h) writes.set(a1(FIRST_BRIDGE_COL + i, 1), h)
  })

  const names = characters.map(c => c.name)
  const validationKey = names.join('\u0000')
  if (!lastValidation || lastValidation.key !== validationKey || Date.now() - lastValidation.at > VALIDATION_REFRESH_MS) {
    await io.applyValidation(names)
    lastValidation = { key: validationKey, at: Date.now() }
  }

  const sheetRows = values.slice(1).map((cells, i) => {
    const get = (c: number) => String(cells[c] ?? '').trim()
    return {
      rowNumber: i + 2,
      account: get(COL.account).replace(/^@/, ''),
      url: get(COL.url),
      character: get(COL.character),
      send: isTicked(get(COL.send)),
      status: get(COL.status),
      jobId: get(COL.jobId),
      error: get(COL.error),
      views: get(COL.views),
      result: get(COL.result),
    }
  })

  const jobs = await loadJobs(owner.id, sheetRows.map(r => r.jobId).filter(id => UUID.test(id)))
  /** Final Job ID per row after this tick's claims — drives the status write-back. */
  const rowJob = new Map<number, string>()
  for (const r of sheetRows) if (jobs.has(r.jobId)) rowJob.set(r.rowNumber, r.jobId)
  /** Notes that must survive this tick's status write-back. */
  const notes = new Map<number, string>()

  const reject = (rowNumber: number, code: WanErrorCode, message: string) => {
    writes.set(a1(COL.send, rowNumber), false)
    writes.set(a1(COL.status, rowNumber), '⚠ Nije poslato')
    writes.set(a1(COL.error, rowNumber), errorText(code, message))
    result.rejected++
    console.warn(`[viral-sheet] row ${rowNumber} not sent [${code}]: ${message}`)
  }

  let claimsLeft = MAX_CLAIMS_PER_TICK
  for (const r of sheetRows.filter(row => row.send)) {
    const existing = jobs.get(r.jobId)

    // ── Row already points at a job: retry if it ended badly, otherwise a no-op tick.
    if (existing) {
      writes.set(a1(COL.send, r.rowNumber), false)
      if (existing.status !== 'failed' && existing.status !== 'cancelled') {
        notes.set(r.rowNumber, errorText('DUPLICATE_JOB',
          existing.status === 'done' ? 'ovaj video je već završen za ovaj karakter' : 'ovaj job je već u obradi'))
        result.duplicates++
        continue
      }
      if (claimsLeft <= 0) { writes.delete(a1(COL.send, r.rowNumber)); continue }
      const outcome = await retrySheetWanJob(existing.id, owner.id)
      if (outcome === 'retried') {
        claimsLeft--
        await queueOrFail(owner.id, existing.id)
        existing.status = 'queued'
        existing.error = null
        existing.error_code = null
        existing.video_result_url = null
        result.retried++
      } else if (outcome === 'duplicate') {
        const live = await findLiveSheetJob(owner.id, existing.id)
        if (live) {
          jobs.set(live.id, live)
          rowJob.set(r.rowNumber, live.id)
          writes.set(a1(COL.jobId, r.rowNumber), live.id)
        }
        notes.set(r.rowNumber, errorText('DUPLICATE_JOB', 'isti reel + karakter je već aktivan u drugom redu — ovaj red sada prati taj job'))
        result.duplicates++
      } else {
        notes.set(r.rowNumber, errorText('INVALID_INPUT', 'ovaj job nije iz Sheeta i ne može se ponoviti odavde'))
        result.rejected++
      }
      continue
    }

    // ── New row → new job.
    const parsed = parseReelUrl(r.url, { allowBareShortcode: false })
    if (!parsed) { reject(r.rowNumber, 'INVALID_INPUT', 'kolona B nema ispravan Instagram reel link'); continue }
    if (!r.character) { reject(r.rowNumber, 'INVALID_INPUT', 'izaberi karakter u koloni J'); continue }
    const character = pickCharacter(characters, r.character)
    if (typeof character === 'string') { reject(r.rowNumber, 'INVALID_INPUT', character); continue }
    if (!owner.telegram_chat_id) {
      reject(r.rowNumber, 'REPLICATOR_UNAVAILABLE', 'Telegram nije povezan sa nalogom — still nema gde da stigne na odobrenje')
      continue
    }
    if (claimsLeft <= 0) continue // stays ticked for the next tick

    const created = await createSheetWanJob({
      userId: owner.id,
      chatId: owner.telegram_chat_id,
      shortCode: parsed.shortCode,
      permalink: parsed.permalink,
      sourceUsername: parsed.ownerUsername ?? (r.account || null),
      characterId: character.id,
      referenceImageUrl: character.reference_image_url!,
      stillPrompt: composeStillPrompt(character.wan_prompt, null) || null,
    })
    writes.set(a1(COL.send, r.rowNumber), false)
    writes.set(a1(COL.jobId, r.rowNumber), created.jobId)
    rowJob.set(r.rowNumber, created.jobId)

    if (created.created) {
      claimsLeft--
      await queueOrFail(owner.id, created.jobId)
      result.claimed++
    } else {
      notes.set(r.rowNumber, errorText('DUPLICATE_JOB',
        `isti reel + karakter je već poslat (job ${created.jobId.slice(0, 8)}) — ovaj red prati taj job`))
      result.duplicates++
    }
  }

  // Jobs created or retried above are re-read so the write-back shows where they really are.
  const fresh = await loadJobs(owner.id, [...new Set(rowJob.values())])

  // ── Status write-back, only for cells that actually changed.
  for (const r of sheetRows) {
    const jobId = rowJob.get(r.rowNumber)
    if (!jobId) {
      if (UUID.test(r.jobId) && r.status !== '⚠ Nepoznat Job ID') writes.set(a1(COL.status, r.rowNumber), '⚠ Nepoznat Job ID')
      continue
    }
    const job = fresh.get(jobId)
    if (!job) continue

    const failed = job.status === 'failed' || job.status === 'cancelled'
    const jobError = failed
      ? errorText(job.error_code ?? (job.status === 'cancelled' ? null : 'UNKNOWN_ERROR'), job.error ?? (job.status === 'cancelled' ? 'otkazano u Telegramu' : ''))
      : ''
    // A duplicate note stays until the job it points at reports its own error.
    const keptNote = !jobError && r.error.startsWith('DUPLICATE_JOB') ? r.error : ''
    const desiredError = notes.get(r.rowNumber) ?? (jobError || keptNote)

    setIfChanged(writes, r.status, a1(COL.status, r.rowNumber), STATUS_LABEL[job.status])
    setIfChanged(writes, r.error, a1(COL.error, r.rowNumber), desiredError)
    if (job.views && job.views > 0 && Number(r.views.replace(/\D/g, '')) !== job.views) {
      writes.set(a1(COL.views, r.rowNumber), job.views)
    }
    setIfChanged(writes, r.result, a1(COL.result, r.rowNumber), job.status === 'done' ? job.video_result_url ?? '' : '')
    if (r.jobId !== jobId) writes.set(a1(COL.jobId, r.rowNumber), jobId)
  }

  const updates = [...writes].map(([cell, value]) => ({ a1: cell, value }))
  await io.writeCells(updates)
  result.cellsWritten = updates.length

  if (result.claimed || result.retried || result.duplicates || result.rejected) {
    console.log(`[viral-sheet] claimed ${result.claimed}, retried ${result.retried}, duplicates ${result.duplicates}, rejected ${result.rejected}, cells ${result.cellsWritten}`)
  }
  return result
}

function setIfChanged(writes: Map<string, CellValue>, current: string, cell: string, desired: string): void {
  if (current !== desired) writes.set(cell, desired)
}

/**
 * Exact name match, case-insensitive — the dropdown offers exactly these names.
 * Returns the reason as a string when the name can't be used.
 */
export function pickCharacter(characters: ContentCharacter[], name: string): ContentCharacter | string {
  const matches = characters.filter(c => c.name.trim().toLowerCase() === name.trim().toLowerCase())
  if (!matches.length) return `karakter "${name}" ne postoji u xxmachine ili nema referentnu fotografiju`
  if (matches.length > 1) return `postoji ${matches.length} karaktera sa imenom "${name}" — preimenuj jednog u xxmachine`
  return matches[0]
}

/** The acquire phase is queued right away; a queue that can't take it fails the job visibly. */
async function queueOrFail(userId: string, jobId: string): Promise<void> {
  try {
    await queueCopyPasteWan(userId, [jobId], 'acquire')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[viral-sheet] queue failed for job ${jobId}:`, msg)
    await markWanJobFailed(jobId, 'REPLICATOR_UNAVAILABLE', `Queue: ${msg}`)
  }
}

async function loadJobs(userId: string, ids: string[]): Promise<Map<string, SheetJob>> {
  if (!ids.length) return new Map()
  const found = await rows<SheetJob>(
    `SELECT j.id, j.status, j.error, j.error_code, j.video_result_url, r.views::float8 AS views
       FROM copy_paste_wan_jobs j
       LEFT JOIN LATERAL (
         SELECT views FROM ig_downloader_reels d
          WHERE d.user_id = j.user_id AND lower(d.shortcode) = lower(j.content_id)
          LIMIT 1
       ) r ON true
      WHERE j.id = ANY($1::uuid[]) AND j.user_id = $2`,
    [ids, userId],
  )
  return new Map(found.map(j => [j.id, j]))
}

/** The live Sheet job that blocked a retry of `failedJobId` (same reel + character). */
async function findLiveSheetJob(userId: string, failedJobId: string): Promise<SheetJob | null> {
  return await one<SheetJob>(
    `SELECT live.id, live.status, live.error, live.error_code, live.video_result_url, NULL::float8 AS views
       FROM copy_paste_wan_jobs old
       JOIN copy_paste_wan_jobs live
         ON live.user_id = old.user_id AND lower(live.content_id) = lower(old.content_id)
        AND live.character_id = old.character_id AND live.origin = 'sheet'
        AND live.status NOT IN ('failed', 'cancelled')
      WHERE old.id = $1 AND old.user_id = $2
      LIMIT 1`,
    [failedJobId, userId],
  )
}

// ── Google Sheets API ────────────────────────────────────────────────────────

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

export async function sheetsRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getGoogleAccessToken(SHEETS_SCOPE)
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
}

/** Which tab a SheetIO works on, and which of its columns get a checkbox or a dropdown (0-based). */
export interface SheetLayout {
  tab: string
  /** readRows covers A1 to this column. */
  lastColumn: string
  checkboxColumns: number[]
  /** Filled with the character names applyValidation is given. */
  characterColumn: number
  fixedDropdowns?: { column: number; values: string[] }[]
}

export const VIRAL_LAYOUT: SheetLayout = {
  tab: VIRAL_TAB,
  lastColumn: columnLetter(COL.result),
  checkboxColumns: [COL.send],
  characterColumn: COL.character,
}

/** A1 notation needs quotes around a tab name with spaces or punctuation ("Sheet1" stays bare). */
export function a1Tab(tab: string): string {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`
}

export function googleSheetIO(sheetId: string = RECREATE_SHEET_ID, layout: SheetLayout = VIRAL_LAYOUT): SheetIO {
  let tabId: number | null = null
  const tab = layout.tab

  return {
    async readRows() {
      const res = await sheetsRequest(`${sheetId}/values/${encodeURIComponent(`${a1Tab(tab)}!A1:${layout.lastColumn}`)}`)
      if (!res.ok) throw new Error(`Failed to read "${tab}": ${res.status} ${await res.text()}`)
      const data = await res.json() as { values?: string[][] }
      return data.values ?? []
    },

    async writeCells(updates) {
      if (!updates.length) return
      const res = await sheetsRequest(`${sheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: updates.map(u => ({ range: u.a1, values: [[u.value]] })),
        }),
      })
      if (!res.ok) throw new Error(`Failed to write "${tab}": ${res.status} ${await res.text()}`)
    },

    async applyValidation(characterNames) {
      if (tabId == null) {
        const meta = await sheetsRequest(`${sheetId}?fields=sheets.properties(sheetId,title)`)
        if (!meta.ok) throw new Error(`Failed to read spreadsheet metadata: ${meta.status} ${await meta.text()}`)
        const data = await meta.json() as { sheets?: { properties?: { sheetId?: number; title?: string } }[] }
        const found = data.sheets?.find(s => s.properties?.title === tab)
        if (found?.properties?.sheetId == null) throw new Error(`Tab "${tab}" not found`)
        tabId = found.properties.sheetId
      }
      const column = (col: number) => ({ sheetId: tabId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 })
      const dropdown = (col: number, values: string[]) => ({
        setDataValidation: {
          range: column(col),
          rule: {
            condition: { type: 'ONE_OF_LIST', values: values.map(userEnteredValue => ({ userEnteredValue })) },
            strict: true,
            showCustomUi: true,
          },
        },
      })
      const requests: unknown[] = layout.checkboxColumns.map(col => ({
        setDataValidation: { range: column(col), rule: { condition: { type: 'BOOLEAN' } } },
      }))
      if (characterNames.length) requests.push(dropdown(layout.characterColumn, characterNames))
      for (const d of layout.fixedDropdowns ?? []) requests.push(dropdown(d.column, d.values))
      const res = await sheetsRequest(`${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
      if (!res.ok) throw new Error(`Failed to set "${tab}" dropdowns: ${res.status} ${await res.text()}`)
    },
  }
}
