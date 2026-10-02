/**
 * Photo Replicator tab: rows, dedupe, header and dropdowns — against an
 * in-memory tab, and the exact Google Sheets requests the real IO sends
 * (fake fetch, throwaway service-account key; no network).
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CellValue } from './viral-sheet'
import {
  PHOTO_COL,
  PHOTO_FORMATS,
  PHOTO_HEADERS,
  PHOTO_SLIDES,
  PREVIEW_FORMULA,
  addPhotoRow,
  formatAdded,
  googlePhotoSheet,
  resetPhotoSheetState,
  type PhotoSheet,
} from './photo-sheet'

class MemoryTab implements PhotoSheet {
  exists = false
  grid: string[][] = []
  validations: string[][] = []
  appends = 0
  async ensureTab() {
    if (this.exists) return false
    this.exists = true
    return true
  }
  async readRows() {
    // Like a real read: the answer reflects the tab when the request went out and
    // arrives a moment later — two unserialised clips would both see "no row yet".
    const snapshot = this.grid.map(r => [...r])
    await new Promise(r => setTimeout(r, 5))
    return snapshot
  }
  async writeCells(updates: { a1: string; value: CellValue }[]) {
    for (const u of updates) {
      const m = u.a1.match(/^'Photo Replicator'!([A-Z])(\d+)$/)
      assert.ok(m, `write outside the Photo Replicator tab: ${u.a1}`)
      const row = (this.grid[Number(m[2]) - 1] ??= [])
      row[m[1].charCodeAt(0) - 65] = String(u.value)
    }
  }
  async applyValidation(names: string[]) {
    this.validations.push(names)
  }
  async appendRow(values: string[]) {
    this.appends++
    this.grid.push([...values])
    return this.grid.length
  }
}

const NAMES = ['Diana Goth', 'Tiana Normal']
const row = (url: string) => ({ imageUrl: url, source: 'https://www.instagram.com/p/ABC123/', addedAt: new Date('2026-10-02T14:33:09Z') })

describe('addPhotoRow', () => {
  beforeEach(() => resetPhotoSheetState())

  it('first clip: creates the tab, writes the 14 headers, sets the dropdowns, adds A–D and leaves E–N empty', async () => {
    const tab = new MemoryTab()
    const got = await addPhotoRow(row('https://store/p1.jpg'), { characterNames: NAMES, sheet: tab })
    assert.deepEqual(got, { rowNumber: 2, appended: true })
    assert.equal(tab.exists, true)
    assert.deepEqual(tab.grid[0], PHOTO_HEADERS)
    assert.deepEqual(tab.grid[1], ['https://store/p1.jpg', PREVIEW_FORMULA, 'https://www.instagram.com/p/ABC123/', '2026-10-02 14:33 UTC'])
    assert.equal(tab.grid[1][PHOTO_COL.character], undefined)
    assert.deepEqual(tab.validations, [NAMES])
  })

  it('the same photo twice is one row', async () => {
    const tab = new MemoryTab()
    await addPhotoRow(row('https://store/p1.jpg'), { characterNames: NAMES, sheet: tab })
    const again = await addPhotoRow(row('https://store/p1.jpg'), { characterNames: NAMES, sheet: tab })
    assert.deepEqual(again, { rowNumber: 2, appended: false })
    assert.equal(tab.appends, 1)
    const third = await addPhotoRow(row('https://store/p2.jpg'), { characterNames: NAMES, sheet: tab })
    assert.deepEqual(third, { rowNumber: 3, appended: true })
  })

  it('two clips of the same photo at the same moment still make one row', async () => {
    const tab = new MemoryTab()
    const [a, b] = await Promise.all([
      addPhotoRow(row('https://store/same.jpg'), { characterNames: NAMES, sheet: tab }),
      addPhotoRow(row('https://store/same.jpg'), { characterNames: NAMES, sheet: tab }),
    ])
    assert.equal(tab.appends, 1)
    assert.deepEqual([a.rowNumber, b.rowNumber].sort(), [2, 2])
    assert.deepEqual([a.appended, b.appended].sort(), [false, true])
  })

  it('a row the person already filled in is found by its photo, not duplicated', async () => {
    const tab = new MemoryTab()
    tab.exists = true
    tab.grid = [[...PHOTO_HEADERS], ['https://store/p1.jpg', PREVIEW_FORMULA, 'src', 'when', 'Diana Goth', 'Carousel', '3', '', 'TRUE']]
    const got = await addPhotoRow(row('https://store/p1.jpg'), { characterNames: NAMES, sheet: tab })
    assert.deepEqual(got, { rowNumber: 2, appended: false })
    assert.equal(tab.grid[1][PHOTO_COL.send], 'TRUE', 'nothing the person typed is touched')
  })

  it('dropdowns are refreshed when the character list changes, not on every clip', async () => {
    const tab = new MemoryTab()
    await addPhotoRow(row('https://store/1.jpg'), { characterNames: NAMES, sheet: tab })
    await addPhotoRow(row('https://store/2.jpg'), { characterNames: NAMES, sheet: tab })
    await addPhotoRow(row('https://store/3.jpg'), { characterNames: [...NAMES, 'Tiana Goth'], sheet: tab })
    assert.deepEqual(tab.validations, [NAMES, [...NAMES, 'Tiana Goth']])
  })

  it('formats the time as plain UTC text', () => {
    assert.equal(formatAdded(new Date('2026-01-05T03:04:59.999Z')), '2026-01-05 03:04 UTC')
  })
})

// ── The real IO's requests ───────────────────────────────────────────────────
interface Call { method: string; url: string; body: unknown }
const calls: Call[] = []
let respond: (url: string, method: string) => Response = () => Response.json({})
let dir = ''
let cwd = ''
const realFetch = globalThis.fetch
const SHEET = 'sheet-x'
const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}`

describe('googlePhotoSheet requests', () => {
  before(() => {
    cwd = process.cwd()
    dir = mkdtempSync(join(tmpdir(), 'photo-sheet-'))
    mkdirSync(join(dir, 'secrets'))
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(join(dir, 'secrets', 'google-service-account.json'), JSON.stringify({
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }))
    process.chdir(dir)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 't', expires_in: 3600 })
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return respond(url, method)
    }) as typeof fetch
  })
  after(() => {
    globalThis.fetch = realFetch
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => { calls.length = 0 })

  const meta = (...titles: string[]) => Response.json({ sheets: titles.map((title, i) => ({ properties: { sheetId: i + 10, title } })) })

  it('creates the tab only when it is missing', async () => {
    respond = () => meta('Sheet1')
    assert.equal(await googlePhotoSheet(SHEET).ensureTab(), true)
    assert.deepEqual(calls[1], {
      method: 'POST',
      url: `${base}:batchUpdate`,
      body: { requests: [{ addSheet: { properties: { title: 'Photo Replicator', gridProperties: { frozenRowCount: 1 } } } }] },
    })
    calls.length = 0
    respond = () => meta('Sheet1', 'Photo Replicator')
    assert.equal(await googlePhotoSheet(SHEET).ensureTab(), false)
    assert.equal(calls.length, 1, 'only the metadata read')
  })

  it('reads A1:N of the quoted tab, appends with formulas evaluated, and returns the row', async () => {
    respond = (url) => url.includes(':append')
      ? Response.json({ updates: { updatedRange: "'Photo Replicator'!A7:D7" } })
      : Response.json({ values: [PHOTO_HEADERS] })
    const io = googlePhotoSheet(SHEET)
    await io.readRows()
    const rowNumber = await io.appendRow(['https://store/p.jpg', PREVIEW_FORMULA, 'https://www.instagram.com/p/X/', '2026-10-02 14:33 UTC'])
    assert.equal(rowNumber, 7)
    assert.equal(calls[0].url, `${base}/values/'Photo%20Replicator'!A1%3AN`)
    assert.deepEqual(calls[1], {
      method: 'POST',
      url: `${base}/values/'Photo%20Replicator'!A%3AD:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      body: { values: [['https://store/p.jpg', PREVIEW_FORMULA, 'https://www.instagram.com/p/X/', '2026-10-02 14:33 UTC']] },
    })
  })

  it('dropdowns: Pošalji checkbox (I), Karakter (E), Format (F), Slajdova (G) — on this tab only', async () => {
    respond = (url) => url.includes('?fields=') ? meta('Sheet1', 'Photo Replicator') : Response.json({})
    await googlePhotoSheet(SHEET).applyValidation(NAMES)
    const col = (c: number) => ({ sheetId: 11, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 })
    const list = (c: number, values: string[]) => ({
      setDataValidation: {
        range: col(c),
        rule: { condition: { type: 'ONE_OF_LIST', values: values.map(userEnteredValue => ({ userEnteredValue })) }, strict: true, showCustomUi: true },
      },
    })
    assert.deepEqual(calls[1].body, {
      requests: [
        { setDataValidation: { range: col(PHOTO_COL.send), rule: { condition: { type: 'BOOLEAN' } } } },
        list(PHOTO_COL.character, NAMES),
        list(PHOTO_COL.format, PHOTO_FORMATS),
        list(PHOTO_COL.slides, PHOTO_SLIDES),
      ],
    })
  })

  it('a whole clip never sends a request about Sheet1', async () => {
    resetPhotoSheetState()
    respond = (url) => url.includes('?fields=') ? meta('Sheet1', 'Photo Replicator')
      : url.includes(':append') ? Response.json({ updates: { updatedRange: "'Photo Replicator'!A2:D2" } })
      : url.includes('/values/') ? Response.json({})
      : Response.json({})
    const got = await addPhotoRow(row('https://store/z.jpg'), { characterNames: NAMES, sheet: googlePhotoSheet(SHEET) })
    assert.deepEqual(got, { rowNumber: 2, appended: true })
    const sent = JSON.stringify(calls)
    assert.doesNotMatch(sent, /Sheet1!|"Sheet1"/)
    assert.ok(calls.some(c => c.url.includes("values:batchUpdate") && JSON.stringify(c.body).includes("'Photo Replicator'!A1")), 'headers written on the Photo tab')
  })
})
