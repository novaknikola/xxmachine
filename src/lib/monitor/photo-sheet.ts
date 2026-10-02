/**
 * "Photo Replicator" tab of the Viral monitoring spreadsheet (RECREATE_SHEET_ID).
 *
 * Phase 1: the Clipper adds one row per clipped photo (A–D) and the person
 * fills E–I. Nothing reads E–N yet — no generation runs from this tab.
 *
 * Same service account and the same SheetIO as the Viral Sheet bridge, pointed
 * at this tab through its layout. Sheet1 is never read or written from here.
 */
import { RECREATE_SHEET_ID } from '@/lib/kling-recreate/sheet-config'
import {
  a1Tab,
  columnLetter,
  googleSheetIO,
  sheetsRequest,
  type CellValue,
  type SheetIO,
  type SheetLayout,
} from './viral-sheet'

export const PHOTO_TAB = 'Photo Replicator'
export const PHOTO_HEADERS = [
  'Slika', 'Pregled', 'Izvor', 'Dodato', 'Karakter', 'Format', 'Slajdova',
  'Dodatak prompta', 'Pošalji', 'Status', 'Job ID', 'Greška', 'Rezultat', 'Farma',
]

/** 0-based column indexes in an A–N row. */
export const PHOTO_COL = {
  image: 0, preview: 1, source: 2, added: 3, character: 4, format: 5, slides: 6,
  addition: 7, send: 8, status: 9, jobId: 10, error: 11, result: 12, farm: 13,
} as const

export const PHOTO_FORMATS = ['Post', 'Carousel', 'Story']
export const PHOTO_SLIDES = ['2', '3']

export const PHOTO_LAYOUT: SheetLayout = {
  tab: PHOTO_TAB,
  lastColumn: columnLetter(PHOTO_COL.farm),
  checkboxColumns: [PHOTO_COL.send],
  characterColumn: PHOTO_COL.character,
  fixedDropdowns: [
    { column: PHOTO_COL.format, values: PHOTO_FORMATS },
    { column: PHOTO_COL.slides, values: PHOTO_SLIDES },
  ],
}

/** B shows the photo in A of the same row, wherever the row ends up after sorting. */
export const PREVIEW_FORMULA = '=IMAGE(INDIRECT("A"&ROW()))'

/** How often the dropdowns are re-applied (rows added since get them too). */
const VALIDATION_REFRESH_MS = 10 * 60_000

export interface PhotoSheet extends SheetIO {
  /** Creates the tab when it is missing; reports how many rows the tab's grid has. */
  ensureTab(): Promise<{ created: boolean; rowCount: number }>
  /**
   * Writes one row from column A (formulas evaluated), growing the grid first
   * when the row is past its end.
   */
  writeRow(rowNumber: number, values: string[], rowCount: number): Promise<void>
}

interface TabMeta { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } } }

/**
 * Rows are written to an explicit row, never through values:append — the
 * Pošalji checkboxes put FALSE in every row of column I, so append would treat
 * the whole grid as one table and write below its last row (row 1001 of an
 * empty tab, found in the L1 test).
 */
export function googlePhotoSheet(sheetId: string = RECREATE_SHEET_ID): PhotoSheet {
  const io = googleSheetIO(sheetId, PHOTO_LAYOUT)
  let tabId: number | null = null
  return {
    ...io,

    async ensureTab() {
      const meta = await sheetsRequest(`${sheetId}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`)
      if (!meta.ok) throw new Error(`Failed to read spreadsheet metadata: ${meta.status} ${await meta.text()}`)
      const data = await meta.json() as { sheets?: TabMeta[] }
      const found = data.sheets?.find(s => s.properties?.title === PHOTO_TAB)
      if (found?.properties?.sheetId != null) {
        tabId = found.properties.sheetId
        return { created: false, rowCount: found.properties.gridProperties?.rowCount ?? 0 }
      }
      const res = await sheetsRequest(`${sheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: PHOTO_TAB, gridProperties: { frozenRowCount: 1 } } } }],
        }),
      })
      if (!res.ok) throw new Error(`Failed to create "${PHOTO_TAB}" tab: ${res.status} ${await res.text()}`)
      const reply = await res.json() as { replies?: { addSheet?: TabMeta }[] }
      const added = reply.replies?.[0]?.addSheet?.properties
      tabId = added?.sheetId ?? null
      return { created: true, rowCount: added?.gridProperties?.rowCount ?? 0 }
    },

    async writeRow(rowNumber, values, rowCount) {
      if (rowNumber > rowCount) {
        if (tabId == null) throw new Error(`"${PHOTO_TAB}" tab id unknown — ensureTab first`)
        const grow = await sheetsRequest(`${sheetId}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({
            requests: [{ appendDimension: { sheetId: tabId, dimension: 'ROWS', length: rowNumber - rowCount + 100 } }],
          }),
        })
        if (!grow.ok) throw new Error(`Failed to add rows to "${PHOTO_TAB}": ${grow.status} ${await grow.text()}`)
      }
      const range = encodeURIComponent(`${a1Tab(PHOTO_TAB)}!A${rowNumber}:${columnLetter(values.length - 1)}${rowNumber}`)
      const res = await sheetsRequest(`${sheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ values: [values] }),
      })
      if (!res.ok) throw new Error(`Failed to write row ${rowNumber} of "${PHOTO_TAB}": ${res.status} ${await res.text()}`)
    },
  }
}

/** "2026-10-02 14:33 UTC" — plain text, so Sheets does not re-read it in its own timezone. */
export function formatAdded(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export interface PhotoRowInput {
  /** Our storage URL — the same photo always has the same one. */
  imageUrl: string
  source: string
  addedAt: Date
}

export interface PhotoRowResult {
  rowNumber: number
  /** False when the photo already had a row and nothing was added. */
  appended: boolean
}

// One Sheet write at a time in this process: two clips of the same photo
// arriving together must not both see "no row yet" and both append.
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

let lastValidation: { key: string; at: number } | null = null

/** Test hook: forget when the dropdowns were last applied. */
export function resetPhotoSheetState(): void {
  lastValidation = null
}

/**
 * Adds the photo as a new row (A–D), unless a row already has it in A. Creates
 * the tab, writes the header and applies the dropdowns as needed on the way.
 */
export async function addPhotoRow(
  input: PhotoRowInput,
  opts: { characterNames: string[]; sheet?: PhotoSheet },
): Promise<PhotoRowResult> {
  return serialized(async () => {
    const sheet = opts.sheet ?? googlePhotoSheet()
    const { created, rowCount } = await sheet.ensureTab()
    const rows = await sheet.readRows()

    const header = rows[0] ?? []
    const headerWrites: { a1: string; value: CellValue }[] = []
    PHOTO_HEADERS.forEach((h, i) => {
      if ((header[i] ?? '') !== h) headerWrites.push({ a1: `${a1Tab(PHOTO_TAB)}!${columnLetter(i)}1`, value: h })
    })
    if (headerWrites.length) await sheet.writeCells(headerWrites)

    const key = opts.characterNames.join('\u0000')
    if (created || !lastValidation || lastValidation.key !== key || Date.now() - lastValidation.at > VALIDATION_REFRESH_MS) {
      await sheet.applyValidation(opts.characterNames)
      lastValidation = { key, at: Date.now() }
    }

    const existing = rows.findIndex((r, i) => i > 0 && String(r[PHOTO_COL.image] ?? '').trim() === input.imageUrl)
    if (existing > 0) return { rowNumber: existing + 1, appended: false }

    // Below the last row that has a photo — the checkbox column is FALSE all the way down.
    const lastWithPhoto = rows.reduce((last, r, i) => (i > 0 && String(r[PHOTO_COL.image] ?? '').trim() ? i : last), 0)
    const rowNumber = lastWithPhoto + 2
    await sheet.writeRow(rowNumber, [input.imageUrl, PREVIEW_FORMULA, input.source, formatAdded(input.addedAt)], rowCount)
    return { rowNumber, appended: true }
  })
}
