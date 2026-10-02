/**
 * Golden: every Google Sheets request the Viral Sheet bridge sends, byte for
 * byte, and the errors it raises. The fixture was recorded from googleSheetIO
 * as it was at 474ddda, before it learned about layouts — the default (Sheet1)
 * layout must keep sending exactly this. No network: fetch is faked, and the
 * service-account key is a throwaway one written to a temp working directory.
 *
 * Re-record only on purpose: GOLDEN_RECORD=1 rewrites the fixture.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = join(__dirname, 'viral-sheet-io.golden.json')
const SHEET_ID = 'golden-sheet'

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
interface Golden { calls: Call[]; errors: string[] }

const calls: Call[] = []
let respond: (url: string, method: string) => Response = () => Response.json({})
let dir = ''
let cwd = ''
const realFetch = globalThis.fetch

before(() => {
  cwd = process.cwd()
  dir = mkdtempSync(join(tmpdir(), 'sheet-golden-'))
  mkdirSync(join(dir, 'secrets'))
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(join(dir, 'secrets', 'google-service-account.json'), JSON.stringify({
    client_email: 'golden@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }))
  process.chdir(dir)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 'golden-token', expires_in: 3600 })
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    calls.push({ method, url, headers, body: init?.body ? JSON.parse(String(init.body)) : null })
    return respond(url, method)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
})

const meta = (title: string) => Response.json({ sheets: [{ properties: { sheetId: 7, title: 'Other' } }, { properties: { sheetId: 42, title } }] })

describe('Viral Sheet IO — golden requests', () => {
  it('sends exactly the recorded requests and raises exactly the recorded errors', async () => {
    const { googleSheetIO } = await import('./viral-sheet')
    const errors: string[] = []
    const fail = async (p: Promise<unknown>) => { await p.then(() => errors.push('no error'), (e: Error) => errors.push(e.message)) }

    // Happy path, one IO instance — the tab id is looked up once and then reused.
    respond = (url) => url.includes('?fields=') ? meta('Sheet1')
      : url.includes('/values/') ? Response.json({ values: [['Nalog', 'Video URL'], ['acc', 'https://www.instagram.com/reel/X/']] })
      : Response.json({})
    const io = googleSheetIO(SHEET_ID)
    assert.deepEqual(await io.readRows(), [['Nalog', 'Video URL'], ['acc', 'https://www.instagram.com/reel/X/']])
    await io.writeCells([])
    await io.writeCells([
      { a1: 'Sheet1!K2', value: false },
      { a1: 'Sheet1!L2', value: '◷ U redu' },
      { a1: 'Sheet1!O2', value: 1234 },
    ])
    await io.applyValidation(['Tiana Goth', 'Diana Normal'])
    await io.applyValidation([])

    // The default spreadsheet id, untouched.
    await googleSheetIO().readRows()

    // Every failure message.
    respond = () => new Response('boom', { status: 500 })
    await fail(googleSheetIO(SHEET_ID).readRows())
    await fail(googleSheetIO(SHEET_ID).writeCells([{ a1: 'Sheet1!K3', value: true }]))
    await fail(googleSheetIO(SHEET_ID).applyValidation(['A']))
    respond = (url) => url.includes('?fields=') ? meta('Not Sheet1') : Response.json({})
    await fail(googleSheetIO(SHEET_ID).applyValidation(['A']))
    respond = (url) => url.includes('?fields=') ? meta('Sheet1') : new Response('bad request', { status: 400 })
    await fail(googleSheetIO(SHEET_ID).applyValidation(['A']))

    const got: Golden = { calls, errors }
    if (process.env.GOLDEN_RECORD === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`)
      return
    }
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden
    assert.deepEqual(got, golden)
  })
})
