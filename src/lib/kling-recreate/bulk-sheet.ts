/**
 * Bulk Google Sheets trigger — lets the user prep several recreate jobs at
 * once in a "Kling Bulk Queue" sheet tab (reel URL or script, reference
 * photos as Drive links, one per character + optional ambiance) and fire
 * them all with one Telegram command (/bulk), instead of building each
 * batch by hand in the chat. See the plan doc for context.
 *
 * Deliberately mirrors sheet-sync.ts's service-account Sheets pattern (not
 * google-sheets.ts's per-user-OAuth variant) — same service account already
 * has access to this user's sheets (idea-bank pipeline, Kling
 * Analysis/Ideas tabs), no new auth setup needed.
 */
import { getGoogleAccessToken } from '@/lib/google-auth'
import { downloadDriveFile } from '@/lib/google-drive'
import { uploadBuffer } from '@/lib/supabase-storage'
import { SHEET_ID } from '@/lib/viral-monitor/config'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
export const BULK_QUEUE_TAB = 'Kling Bulk Queue'
const BULK_QUEUE_HEADERS = [
  'Status', 'Reel URL', 'Script', 'Instruction/Context',
  'Character 1 Name', 'Character 1 Drive URL',
  'Character 2 Name', 'Character 2 Drive URL',
  'Character 3 Name', 'Character 3 Drive URL',
  'Ambiance Drive URL',
  'Job ID', 'Video URL', 'Error',
]
/** Explicit user ask: a hard cap per /bulk trigger so one careless tap can't
 * fire an unbounded, unexpectedly expensive batch. */
export const MAX_BULK_ROWS = 5

async function sheetsRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getGoogleAccessToken(SHEETS_SCOPE)
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
}

async function ensureBulkQueueTab(): Promise<void> {
  if (!SHEET_ID) return
  const metaRes = await sheetsRequest(`${SHEET_ID}?fields=sheets.properties(sheetId,title)`)
  if (!metaRes.ok) throw new Error(`Failed to read spreadsheet metadata: ${metaRes.status} ${await metaRes.text()}`)
  const meta = await metaRes.json() as { sheets?: { properties?: { sheetId?: number; title?: string } }[] }
  const exists = (meta.sheets ?? []).some(s => s.properties?.title === BULK_QUEUE_TAB)

  if (!exists) {
    const create = await sheetsRequest(`${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: BULK_QUEUE_TAB, gridProperties: { frozenRowCount: 1 } } } }],
      }),
    })
    if (!create.ok) throw new Error(`Failed to create "${BULK_QUEUE_TAB}" tab: ${create.status} ${await create.text()}`)
  }

  const headerRes = await sheetsRequest(`${SHEET_ID}/values/${encodeURIComponent(`${BULK_QUEUE_TAB}!A1:N1`)}`)
  if (!headerRes.ok) throw new Error(`Failed to read "${BULK_QUEUE_TAB}" header: ${headerRes.status} ${await headerRes.text()}`)
  const headerData = await headerRes.json() as { values?: string[][] }
  if (!(headerData.values?.[0]?.length)) {
    const write = await sheetsRequest(
      `${SHEET_ID}/values/${encodeURIComponent(`${BULK_QUEUE_TAB}!A1`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [BULK_QUEUE_HEADERS] }) },
    )
    if (!write.ok) throw new Error(`Failed to write "${BULK_QUEUE_TAB}" header: ${write.status} ${await write.text()}`)
  }
}

async function readRange(range: string): Promise<string[][]> {
  const res = await sheetsRequest(`${SHEET_ID}/values/${encodeURIComponent(range)}`)
  if (!res.ok) throw new Error(`Failed to read "${range}": ${res.status} ${await res.text()}`)
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

export interface BulkQueueCharacter {
  name: string
  driveUrl: string
}

export interface BulkQueueRow {
  rowNumber: number
  status: string
  reelUrl: string | null
  script: string | null
  instruction: string | null
  characters: BulkQueueCharacter[]
  ambianceDriveUrl: string | null
}

/**
 * Unclaimed (no Job ID yet), valid (a reel URL or script, plus at least one
 * character photo) rows, oldest-first, capped at MAX_BULK_ROWS. A row with
 * both a Reel URL and a Script has the Reel URL win — the caller doesn't
 * need to choose.
 */
export async function readBulkQueueRows(): Promise<BulkQueueRow[]> {
  if (!SHEET_ID) return []
  await ensureBulkQueueTab()
  const raw = await readRange(`${BULK_QUEUE_TAB}!A2:N1000`)

  const rows: BulkQueueRow[] = []
  raw.forEach((cells, i) => {
    const get = (idx: number) => (cells[idx] ?? '').trim()
    const jobId = get(11)
    if (jobId) return // already claimed by an earlier /bulk

    const reelUrl = get(1) || null
    const script = get(2) || null
    if (!reelUrl && !script) return

    const characters: BulkQueueCharacter[] = []
    for (const [nameIdx, urlIdx] of [[4, 5], [6, 7], [8, 9]] as const) {
      const name = get(nameIdx)
      const driveUrl = get(urlIdx)
      if (name && driveUrl) characters.push({ name, driveUrl })
    }
    if (!characters.length) return

    rows.push({
      rowNumber: i + 2,
      status: get(0),
      reelUrl,
      script,
      instruction: get(3) || null,
      characters,
      ambianceDriveUrl: get(10) || null,
    })
  })

  return rows.slice(0, MAX_BULK_ROWS)
}

/** Best-effort — a Sheet write failure must never fail the actual job. */
export async function writeBulkRowStatus(rowNumber: number, fields: {
  status?: string
  jobId?: string
  videoUrl?: string
  error?: string
}): Promise<void> {
  if (!SHEET_ID) return
  try {
    const data: { range: string; values: string[][] }[] = []
    if (fields.status !== undefined) data.push({ range: `${BULK_QUEUE_TAB}!A${rowNumber}`, values: [[fields.status]] })
    if (fields.jobId !== undefined) data.push({ range: `${BULK_QUEUE_TAB}!L${rowNumber}`, values: [[fields.jobId]] })
    if (fields.videoUrl !== undefined) data.push({ range: `${BULK_QUEUE_TAB}!M${rowNumber}`, values: [[fields.videoUrl]] })
    if (fields.error !== undefined) data.push({ range: `${BULK_QUEUE_TAB}!N${rowNumber}`, values: [[fields.error]] })
    if (!data.length) return

    const res = await sheetsRequest(`${SHEET_ID}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    })
    if (!res.ok) console.warn('[kling-recreate] bulk sheet status write failed:', res.status, await res.text())
  } catch (err) {
    console.error('[kling-recreate] bulk sheet status write failed:', err)
  }
}

/**
 * Parses the file id out of the common Drive share-link shapes, or accepts
 * a bare id typed directly. Returns null (not a throw) on anything
 * unrecognized so callers can report a clean per-row error instead of an
 * exception mid-batch.
 */
export function extractDriveFileId(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/d\/([a-zA-Z0-9_-]+)/]
  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) return match[1]
  }
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed
  return null
}

/**
 * Download a Drive-hosted reference photo and re-host it on our own storage
 * — WaveSpeed can't fetch an auth-gated Drive URL directly, same reasoning
 * as holdPendingPhotoRole's download-then-rehost for Telegram photos.
 */
export async function resolveDrivePhoto(driveUrl: string, path: string): Promise<string> {
  const fileId = extractDriveFileId(driveUrl)
  if (!fileId) throw new Error(`Could not parse a Drive file id from: ${driveUrl}`)
  const buffer = await downloadDriveFile(fileId)
  return uploadBuffer(buffer, path, 'image/jpeg')
}
