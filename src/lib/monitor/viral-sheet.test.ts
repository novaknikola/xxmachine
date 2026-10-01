/**
 * Viral monitoring Sheet → IG Replicator bridge, end to end against a real
 * Postgres (TEST_DATABASE_URL — skipped without it) and the real queue worker
 * route. Only the outside world is faked: WaveSpeed, Telegram, Supabase
 * storage and the Instagram CDN (a local HTTP server), and the Sheet itself
 * (an in-memory SheetIO).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { CellValue, SheetIO } from './viral-sheet'
import { inkIn, renderInkFixtures, streamFacts, type InkFixtures } from './ink-fixture.test-util'
import { WAN_MOTION_REFERENCE_PROMPT } from './wan-reference'

const TEST_DB = process.env.TEST_DATABASE_URL

// ── Fake Sheet ───────────────────────────────────────────────────────────────

const HEADER = ['Nalog', 'Video URL', 'Skor', 'Kategorija', 'Lajkovi', 'Komentari', 'Repost', 'Pratioci', 'Vreme']

class MemorySheet implements SheetIO {
  grid: string[][] = [[...HEADER]]
  validations: string[][] = []

  addRow(account: string, url: string, character = '', send = false): number {
    this.grid.push([account, url, '12.5', 'Viralno', '100', '5', '1', '1000', new Date().toISOString(), character, send ? 'TRUE' : 'FALSE'])
    return this.grid.length // 1-based row number
  }
  cell(row: number, col: string): string {
    return this.grid[row - 1]?.[col.charCodeAt(0) - 65] ?? ''
  }
  set(row: number, col: string, value: string) {
    const r = this.grid[row - 1]
    r[col.charCodeAt(0) - 65] = value
    for (let i = 0; i < r.length; i++) r[i] ??= ''
  }
  async readRows() {
    return this.grid.map(r => r.map(c => c ?? ''))
  }
  async writeCells(updates: { a1: string; value: CellValue }[]) {
    for (const u of updates) {
      const m = u.a1.match(/^Sheet1!([A-Z])(\d+)$/)
      assert.ok(m, `bad a1 ${u.a1}`)
      const v = typeof u.value === 'boolean' ? (u.value ? 'TRUE' : 'FALSE') : String(u.value)
      const row = this.grid[Number(m[2]) - 1] ?? (this.grid[Number(m[2]) - 1] = [])
      row[m[1].charCodeAt(0) - 65] = v
      for (let i = 0; i < row.length; i++) row[i] ??= ''
    }
  }
  async applyValidation(names: string[]) {
    this.validations.push(names)
  }
}

// ── Fake outside world ───────────────────────────────────────────────────────

const store = new Map<string, { body: Buffer; type: string }>()
const telegramCalls: { method: string; body: Record<string, unknown> }[] = []
const wavespeedPosts: { url: string; body: Record<string, unknown> }[] = []
let wavespeedFail = false
let ink: InkFixtures
/** What the fake WaveSpeed hands back: images (Seedream / Z-Image) and the background remover's matte. */
const served: { image: Buffer; matte: Buffer } = { image: Buffer.alloc(0), matte: Buffer.alloc(0) }
let base = ''
let server: http.Server
const workerRuns = new Set<Promise<unknown>>()

type Mod = {
  sync: typeof import('./viral-sheet')
  wan: typeof import('./wan-jobs')
  queue: typeof import('./wan-queue')
  db: typeof import('@/lib/db')
}
let m: Mod
let ownerId = ''

async function drainWorkers() {
  while (workerRuns.size) await Promise.allSettled([...workerRuns])
}

async function jobRow(id: string) {
  return (await m.db.one<{ status: string; error_code: string | null; error: string | null; video_url: string | null; origin: string; completed_at: Date | null }>(
    `SELECT status, error_code, error, video_url, origin, completed_at FROM copy_paste_wan_jobs WHERE id = $1`, [id]))!
}

/** A local copy of what a URL serves — the fake servers live in this process, so ffmpeg must not read them synchronously. */
async function localCopy(url: string): Promise<string> {
  const res = await fetch(url)
  assert.ok(res.ok, `fetch ${url}: ${res.status}`)
  const file = join(mkdtempSync(join(tmpdir(), 'media-')), 'media')
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

const inkAt = async (url: string) => inkIn(await localCopy(url))

/** One cron tick of the bridge, then let every worker it kicked finish. */
async function tick(sheet: MemorySheet) {
  const r = await m.sync.syncViralSheet(sheet)
  await drainWorkers()
  return r
}

describe('viral sheet → IG Replicator bridge', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'viral-sheet-test-'))
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=360x640:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', join(dir, 'reel.mp4')])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(dir, 'reel.mp4'), '-frames:v', '1', join(dir, 'out.jpg')])
    const reel = readFileSync(join(dir, 'reel.mp4'))
    const jpg = readFileSync(join(dir, 'out.jpg'))
    ink = renderInkFixtures(dir)
    const inkedReel = readFileSync(ink.source)
    // The plain reel's "matte": its right half is the subject, the left half key green.
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(dir, 'reel.mp4'), '-vf', 'drawbox=x=0:y=0:w=iw/2:h=ih:color=0x00FF00:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'reel-matte.mp4')])
    Object.assign(served, { image: jpg, matte: readFileSync(join(dir, 'reel-matte.mp4')) })

    server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url.startsWith('/storage/v1/object/generations/')) {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          store.set(url.replace('/storage/v1/object/generations/', ''), {
            body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? ''),
          })
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        })
        return
      }
      if (url.startsWith('/storage/v1/object/public/generations/')) {
        const f = store.get(url.replace('/storage/v1/object/public/generations/', ''))
        if (!f) return void res.writeHead(404).end()
        return void res.writeHead(200, { 'content-type': f.type }).end(f.body)
      }
      if (url === '/cdn/reel.mp4' || url === '/ws/out.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(reel)
      if (url === '/cdn/inked.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(inkedReel)
      if (url === '/ws/matte.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(served.matte)
      if (url === '/ws/out.jpg') return void res.writeHead(200, { 'content-type': 'image/jpeg' }).end(served.image)
      res.writeHead(404).end('not found')
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    Object.assign(process.env, {
      DATABASE_URL: TEST_DB,
      SUPABASE_URL: base,
      SUPABASE_SERVICE_KEY: 'test',
      WAVESPEED_API_KEY: 'test',
      TELEGRAM_BOT_TOKEN: 'test',
      CRON_SECRET: 'test-cron',
      INTERNAL_BASE_URL: 'http://queue.internal',
      OWNER_EMAIL: `owner-${randomUUID()}@test.local`,
    })
    delete process.env.APIFY_API_KEY

    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('http://queue.internal/api/queue/process/')) {
        // The worker the app fires at itself — run the real route in-process.
        // Registered before the first await, so drainWorkers() never misses a run.
        const id = url.split('/').pop()!
        const run = (async () => {
          const { POST } = await import('@/app/api/queue/process/[id]/route')
          const { NextRequest } = await import('next/server')
          return POST(new NextRequest(url, { method: 'POST', headers: { 'x-cron-secret': 'test-cron' } }), {
            params: Promise.resolve({ id }),
          } as never)
        })()
        workerRuns.add(run)
        run.finally(() => workerRuns.delete(run))
        return new Response('{}')
      }
      if (url.includes('api.wavespeed.ai')) {
        if (init?.method === 'POST') {
          wavespeedPosts.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} })
          if (wavespeedFail) return Response.json({ code: 500, message: 'model overloaded' })
          const id = /wan/i.test(url) ? 'req-wan' : url.includes('video-background-remover') ? 'req-matte' : 'req-img'
          return Response.json({ code: 200, data: { id } })
        }
        const output = url.includes('req-wan') ? `${base}/ws/out.mp4`
          : url.includes('req-matte') ? `${base}/ws/matte.mp4` : `${base}/ws/out.jpg`
        return Response.json({ code: 200, data: { status: 'completed', outputs: [output] } })
      }
      if (url.includes('api.telegram.org')) {
        const method = url.split('/').pop()!
        telegramCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} })
        return Response.json({ ok: true, result: { message_id: telegramCalls.length } })
      }
      return realFetch(input, init)
    }) as typeof fetch

    m = {
      sync: await import('./viral-sheet'),
      wan: await import('./wan-jobs'),
      queue: await import('./wan-queue'),
      db: await import('@/lib/db'),
    }

    const owner = await m.db.one<{ id: string }>(
      `INSERT INTO users (email, display_name, role, password_hash, telegram_chat_id)
       VALUES ($1, 'Owner', 'admin', 'x', 424242) RETURNING id`,
      [process.env.OWNER_EMAIL],
    )
    ownerId = owner!.id
    const ref = `${base}/ws/out.jpg`
    for (const [name, refUrl] of [
      ['Tiana Goth', ref], ['Diana Normal', ref], ['Twin', ref], ['twin', ref], ['No Photo', null],
    ] as const) {
      await m.db.query(`INSERT INTO characters (user_id, name, reference_image_url) VALUES ($1, $2, $3)`, [ownerId, name, refUrl])
    }
  })

  after(async () => {
    await drainWorkers()
    await m?.db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => {})
    server?.close()
    // pg pool keeps the process alive otherwise.
    await (globalThis as { __xmDbPool?: { end(): Promise<void> } }).__xmDbPool?.end()
  })

  /** A reel the resolver finds in its own cache, served by the fake CDN. */
  async function cachedReel(code: string, views = 2_400_000, cdnPath = '/cdn/reel.mp4') {
    await m.db.query(
      `INSERT INTO ig_downloader_reels (user_id, username, shortcode, permalink, video_url, views, source)
       VALUES ($1, 'creator', $2, $3, $4, $5, 'test')`,
      [ownerId, code, `https://www.instagram.com/reel/${code}/`, `${base}${cdnPath}`, views],
    )
    return `https://www.instagram.com/reels/${code}/`
  }

  it('1 + 8. normal video: tick → acquire → stored → still in Telegram; approve → Wan → completed', async () => {
    const sheet = new MemorySheet()
    const url = await cachedReel('NormalReel01')
    const row = sheet.addRow('creator', url, 'Tiana Goth', true)

    const r = await tick(sheet)
    assert.equal(r.claimed, 1)
    // Only characters with a reference photo are offered.
    assert.deepEqual([...sheet.validations.at(-1)!].sort(), ['Diana Normal', 'Tiana Goth', 'Twin', 'twin'])
    assert.equal(sheet.cell(1, 'J'), 'Karakter')
    assert.equal(sheet.cell(row, 'K'), 'FALSE')
    const jobId = sheet.cell(row, 'M')
    assert.match(jobId, /^[0-9a-f-]{36}$/)

    const job = await jobRow(jobId)
    assert.equal(job.origin, 'sheet')
    assert.equal(job.status, 'awaiting_approval')
    assert.equal(job.video_url, `${base}/storage/v1/object/public/generations/monitor/${jobId}/source.mp4`)
    assert.ok(store.has(`monitor/${jobId}/source.mp4`), 'source copied to storage')
    // The reel cache now answers with our copy, not the CDN link it was found under.
    const cached = await m.db.one<{ video_url: string }>(
      `SELECT video_url FROM ig_downloader_reels WHERE user_id = $1 AND shortcode = 'NormalReel01'`, [ownerId])
    assert.equal(cached!.video_url, job.video_url)
    const photo = telegramCalls.find(c => c.method === 'sendPhoto')
    assert.ok(photo, 'still sent to Telegram')
    assert.equal(String(photo!.body.chat_id), '424242')

    await tick(sheet) // write-back
    assert.equal(sheet.cell(row, 'L'), '⏸ Čeka Approve (Telegram)')
    assert.equal(sheet.cell(row, 'O'), '2400000')

    // What the Telegram ✅ Approve button does (webhook wanok).
    await m.db.query(`UPDATE copy_paste_wan_jobs SET status = 'approved' WHERE id = $1`, [jobId])
    await m.queue.queueCopyPasteWan(ownerId, [jobId], 'video')
    await drainWorkers()
    const done = await jobRow(jobId)
    assert.equal(done.status, 'done')
    assert.ok(done.completed_at)

    await tick(sheet)
    assert.equal(sheet.cell(row, 'L'), '✓ Završeno')
    assert.equal(sheet.cell(row, 'P'), `${base}/storage/v1/object/public/generations/monitor/${jobId}/wan-result.mp4`)

    // 8. Already-completed video ticked again: no second job.
    sheet.set(row, 'K', 'TRUE')
    const again = await tick(sheet)
    assert.equal(again.claimed + again.retried, 0)
    assert.equal(again.duplicates, 1)
    assert.equal(sheet.cell(row, 'M'), jobId)
    assert.match(sheet.cell(row, 'N'), /^DUPLICATE_JOB: ovaj video je već završen/)
    const count = await m.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM copy_paste_wan_jobs WHERE user_id = $1 AND content_id = 'NormalReel01'`, [ownerId])
    assert.equal(count!.n, 1)
  })

  it('2. duplicate: same reel + same character in two rows → one job; other character → its own job', async () => {
    const sheet = new MemorySheet()
    const url = await cachedReel('DupReel0001')
    const a = sheet.addRow('creator', url, 'Tiana Goth', true)
    const b = sheet.addRow('creator', url.replace('/reels/', '/reel/'), 'tiana goth', true)
    const c = sheet.addRow('creator', url, 'Diana Normal', true)

    const r = await tick(sheet)
    assert.equal(r.claimed, 2)
    assert.equal(r.duplicates, 1)
    assert.equal(sheet.cell(a, 'M'), sheet.cell(b, 'M'), 'duplicate row follows the same job')
    assert.notEqual(sheet.cell(a, 'M'), sheet.cell(c, 'M'))
    assert.match(sheet.cell(b, 'N'), /^DUPLICATE_JOB/)

    await tick(sheet)
    assert.match(sheet.cell(b, 'N'), /^DUPLICATE_JOB/, 'note survives the next write-back')
    assert.equal(sheet.cell(b, 'L'), sheet.cell(a, 'L'))
  })

  it('3. acquisition failure: no fetcher can resolve the reel → ACQUISITION_FAILED in the Sheet', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow('creator', 'https://www.instagram.com/reels/NotCached001/', 'Tiana Goth', true)
    await tick(sheet)
    const job = await jobRow(sheet.cell(row, 'M'))
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'ACQUISITION_FAILED')
    await tick(sheet)
    assert.equal(sheet.cell(row, 'L'), '⚠ Greška — čekiraj Pošalji za retry')
    assert.match(sheet.cell(row, 'N'), /^ACQUISITION_FAILED: Could not fetch that reel\. No reel fetcher configured/)
  })

  it('3b. download failure: the reel was found, its CDN link is dead → DOWNLOAD_FAILED', async () => {
    const sheet = new MemorySheet()
    await m.db.query(
      `INSERT INTO ig_downloader_reels (user_id, username, shortcode, permalink, video_url, source)
       VALUES ($1, 'creator', 'DeadLink0001', 'x', $2, 'test')`, [ownerId, `${base}/cdn/expired.mp4`])
    const row = sheet.addRow('creator', 'https://www.instagram.com/reels/DeadLink0001/', 'Tiana Goth', true)
    await tick(sheet)
    const job = await jobRow(sheet.cell(row, 'M'))
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'DOWNLOAD_FAILED')
    assert.match(job.error ?? '', /^The Reel was found, but the video could not be downloaded: track fetch failed: 404/)
  })

  it('4 + 5. Replicator failure → PROCESSING_FAILED; ticking again retries the same job to success', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow('creator', await cachedReel('FailRetry001'), 'Tiana Goth', true)
    wavespeedFail = true
    try {
      await tick(sheet)
    } finally {
      wavespeedFail = false
    }
    const jobId = sheet.cell(row, 'M')
    let job = await jobRow(jobId)
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'PROCESSING_FAILED')
    await tick(sheet)
    assert.match(sheet.cell(row, 'N'), /^PROCESSING_FAILED: .*model overloaded/)

    // Explicit retry: tick the checkbox again.
    sheet.set(row, 'K', 'TRUE')
    const r = await tick(sheet)
    assert.equal(r.retried, 1)
    assert.equal(sheet.cell(row, 'M'), jobId, 'same job, not a new one')
    job = await jobRow(jobId)
    assert.equal(job.status, 'awaiting_approval')
    assert.equal(job.error_code, null)
    await tick(sheet)
    assert.equal(sheet.cell(row, 'N'), '')
    assert.equal(sheet.cell(row, 'L'), '⏸ Čeka Approve (Telegram)')
  })

  it('6. multiple videos: 7 ticked rows → 5 this tick (cap), the other 2 on the next', async () => {
    const sheet = new MemorySheet()
    const rows: number[] = []
    for (let i = 0; i < 7; i++) rows.push(sheet.addRow('creator', await cachedReel(`Multi00000${i}`), 'Diana Normal', true))
    const first = await tick(sheet)
    assert.equal(first.claimed, m.sync.MAX_CLAIMS_PER_TICK)
    assert.equal(rows.filter(r => sheet.cell(r, 'K') === 'TRUE').length, 2)
    const second = await tick(sheet)
    assert.equal(second.claimed, 2)
    const ids = new Set(rows.map(r => sheet.cell(r, 'M')))
    assert.equal(ids.size, 7)
    for (const id of ids) assert.equal((await jobRow(id)).status, 'awaiting_approval')
  })

  it('7. restart: a worker that died mid-acquire is failed as STALLED by the cron sweep; a queue retry resumes it', async () => {
    // Crash mid-acquire, queue retry: acquire re-enters 'acquiring' and finishes.
    const url = await cachedReel('Restart00001')
    const resumed = await m.wan.createSheetWanJob({
      userId: ownerId, chatId: 424242, shortCode: 'Restart00001', permalink: url, sourceUsername: 'creator',
      characterId: (await m.db.one<{ id: string }>(`SELECT id FROM characters WHERE user_id = $1 AND name = 'Tiana Goth'`, [ownerId]))!.id,
      referenceImageUrl: `${base}/ws/out.jpg`, stillPrompt: null,
    })
    await m.db.query(`UPDATE copy_paste_wan_jobs SET status = 'acquiring', started_at = now() WHERE id = $1`, [resumed.jobId])
    await m.queue.queueCopyPasteWan(ownerId, [resumed.jobId], 'acquire')
    await drainWorkers()
    assert.equal((await jobRow(resumed.jobId)).status, 'awaiting_approval')

    // Dead worker, nobody retries: the stale sweep fails the item, not just the queue row.
    const stuck = await m.db.one<{ id: string }>(
      `INSERT INTO copy_paste_wan_jobs (user_id, content_url, content_id, reference_image_url, status, origin, started_at)
       VALUES ($1, 'https://www.instagram.com/reel/Stuck0000001/', 'Stuck0000001', 'x', 'generating', 'sheet', now())
       RETURNING id`, [ownerId])
    const q = await m.db.one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, status, started_at, total_items)
       VALUES ($1, 'copy_paste_wan', $2, 'failed', now() - interval '20 minutes', 1) RETURNING id`,
      [ownerId, JSON.stringify({ jobIds: [stuck!.id], phase: 'video' })])
    assert.equal(await m.wan.failStaleWanItems(q!.id, 'Job stalled — test'), 1)
    const job = await jobRow(stuck!.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'STALLED')

    // An item a newer live queue job owns is left alone.
    const regen = await m.db.one<{ id: string }>(
      `INSERT INTO copy_paste_wan_jobs (user_id, content_url, content_id, reference_image_url, status)
       VALUES ($1, 'u', 'Regen0000001', 'x', 'awaiting_confirm') RETURNING id`, [ownerId])
    const oldQ = await m.db.one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, status) VALUES ($1, 'copy_paste_wan', $2, 'failed') RETURNING id`,
      [ownerId, JSON.stringify({ jobIds: [regen!.id], phase: 'still' })])
    await m.db.query(
      `INSERT INTO generation_queue (user_id, job_type, input, status) VALUES ($1, 'copy_paste_wan', $2, 'pending')`,
      [ownerId, JSON.stringify({ jobIds: [regen!.id], phase: 'still' })])
    assert.equal(await m.wan.failStaleWanItems(oldQ!.id, 'Job stalled — test'), 0)
    await m.db.query(`DELETE FROM generation_queue WHERE user_id = $1 AND status = 'pending'`, [ownerId])
  })

  it('9. invalid input is refused with a concrete reason and never creates a job', async () => {
    const sheet = new MemorySheet()
    const noUrl = sheet.addRow('creator', '', 'Tiana Goth', true)
    const badUrl = sheet.addRow('creator', 'https://example.com/reels/abcdef/', 'Tiana Goth', true)
    const noChar = sheet.addRow('creator', 'https://www.instagram.com/reels/Invalid00001/', '', true)
    const unknown = sheet.addRow('creator', 'https://www.instagram.com/reels/Invalid00002/', 'Nobody', true)
    const twin = sheet.addRow('creator', 'https://www.instagram.com/reels/Invalid00003/', 'Twin', true)
    const noPhoto = sheet.addRow('creator', 'https://www.instagram.com/reels/Invalid00004/', 'No Photo', true)
    const foreignJob = sheet.addRow('creator', 'https://www.instagram.com/reels/Invalid00005/', 'Tiana Goth', false)
    sheet.set(foreignJob, 'M', randomUUID())

    const r = await tick(sheet)
    assert.equal(r.claimed, 0)
    assert.equal(r.rejected, 6)
    assert.match(sheet.cell(noUrl, 'N'), /^INVALID_INPUT: kolona B/)
    assert.match(sheet.cell(badUrl, 'N'), /^INVALID_INPUT: kolona B/)
    assert.match(sheet.cell(noChar, 'N'), /^INVALID_INPUT: izaberi karakter/)
    assert.match(sheet.cell(unknown, 'N'), /ne postoji/)
    assert.match(sheet.cell(twin, 'N'), /postoji 2 karaktera/)
    assert.match(sheet.cell(noPhoto, 'N'), /ne postoji u xxmachine ili nema referentnu fotografiju/)
    for (const row of [noUrl, badUrl, noChar, unknown, twin, noPhoto]) {
      assert.equal(sheet.cell(row, 'K'), 'FALSE')
      assert.equal(sheet.cell(row, 'L'), '⚠ Nije poslato')
    }
    assert.equal(sheet.cell(foreignJob, 'L'), '⚠ Nepoznat Job ID')

    // Owner without Telegram: nowhere to send the still for approval.
    await m.db.query(`UPDATE users SET telegram_chat_id = NULL WHERE id = $1`, [ownerId])
    try {
      const s2 = new MemorySheet()
      const row = s2.addRow('creator', await cachedReel('NoTelegram01'), 'Tiana Goth', true)
      await tick(s2)
      assert.match(s2.cell(row, 'N'), /^REPLICATOR_UNAVAILABLE: Telegram nije povezan/)
      assert.equal(s2.cell(row, 'M'), '')
    } finally {
      await m.db.query(`UPDATE users SET telegram_chat_id = 424242 WHERE id = $1`, [ownerId])
    }
  })

  it('10. race: two ticks reading the same ticked row at once, and 10 parallel inserts, give one job', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow('creator', await cachedReel('RaceReel0001'), 'Tiana Goth', true)
    const [a, b] = await Promise.all([m.sync.syncViralSheet(sheet), m.sync.syncViralSheet(sheet)])
    await drainWorkers()
    assert.equal(a.claimed + b.claimed, 1)
    const n = await m.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM copy_paste_wan_jobs WHERE user_id = $1 AND content_id = 'RaceReel0001'`, [ownerId])
    assert.equal(n!.n, 1)
    await tick(sheet)
    assert.equal(sheet.cell(row, 'L'), '⏸ Čeka Approve (Telegram)')

    const characterId = (await m.db.one<{ id: string }>(`SELECT id FROM characters WHERE user_id = $1 AND name = 'Diana Normal'`, [ownerId]))!.id
    const results = await Promise.all(Array.from({ length: 10 }, () => m.wan.createSheetWanJob({
      userId: ownerId, chatId: 424242, shortCode: 'RaceReel0002', permalink: 'https://www.instagram.com/reel/RaceReel0002/',
      sourceUsername: null, characterId, referenceImageUrl: 'x', stillPrompt: null,
    })))
    assert.equal(results.filter(x => x.created).length, 1)
    assert.equal(new Set(results.map(x => x.jobId)).size, 1)
  })

  it('12. Telegram submission: the job keeps our checked copy, never the provider CDN link', async () => {
    const url = await cachedReel('TgCopy00001')
    const created = await m.wan.createWanJobsFromUrls({
      userId: ownerId, chatId: 424242, rawText: url, referenceImageUrl: `${base}/ws/out.jpg`,
    })
    assert.equal(created.jobIds.length, 1)
    assert.equal(created.noAudioCount, 0)
    const jobId = created.jobIds[0]
    const job = await jobRow(jobId)
    assert.equal(job.video_url, `${base}/storage/v1/object/public/generations/monitor/${jobId}/source.mp4`)
    assert.notEqual(job.video_url, `${base}/cdn/reel.mp4`)
    assert.ok(store.has(`monitor/${jobId}/source.mp4`))

    // A dead link is reported per reel as a download failure, not a resolve failure.
    await m.db.query(
      `INSERT INTO ig_downloader_reels (user_id, username, shortcode, permalink, video_url, source)
       VALUES ($1, 'creator', 'TgDead00001', 'x', $2, 'test')`, [ownerId, `${base}/cdn/expired.mp4`])
    const dead = await m.wan.createWanJobsFromUrls({
      userId: ownerId, chatId: 424242, rawText: 'https://www.instagram.com/reel/TgDead00001/', referenceImageUrl: `${base}/ws/out.jpg`,
    })
    assert.equal(dead.jobIds.length, 0)
    assert.match(dead.resolveErrors[0].error, /^DOWNLOAD_FAILED: The Reel was found, but the video could not be downloaded/)
  })

  it('11. tattoos on the source person never reach Wan: every reference it gets is ink-free', async () => {
    // The source reel's subject carries ink; the character photo and the scene
    // still (what Seedream / Z-Image return here) are clean — the exact bug setup.
    const prev = { ...served }
    const mine = wavespeedPosts.length // calls from earlier tests are not this job's
    Object.assign(served, { image: readFileSync(ink.cleanImage), matte: readFileSync(ink.matte) })
    try {
      const sheet = new MemorySheet()
      const row = sheet.addRow('creator', await cachedReel('InkedReel001', 2_400_000, '/cdn/inked.mp4'), 'Tiana Goth', true)
      await tick(sheet)
      const jobId = sheet.cell(row, 'M')
      const urls = () => m.db.one<{ video_url: string; reference_image_url: string; still_image_url: string; motion_video_url: string | null }>(
        `SELECT video_url, reference_image_url, still_image_url, motion_video_url FROM copy_paste_wan_jobs WHERE id = $1`, [jobId])
      assert.equal((await jobRow(jobId)).status, 'awaiting_approval')
      const firstStill = (await urls())!.still_image_url
      const matteCalls = () => wavespeedPosts.slice(mine).filter(p => p.url.endsWith('/wavespeed-ai/video-background-remover'))
      const mattes = matteCalls().length
      assert.equal(mattes, 1, 'one matte, built with the first still')

      // Regenerate: a new still under a new URL (a re-used URL can be served
      // stale — the rejected still), the same motion reference, no second matte.
      const motionBefore = (await urls())!.motion_video_url
      await m.db.query(`UPDATE copy_paste_wan_jobs SET status = 'awaiting_confirm' WHERE id = $1`, [jobId])
      await m.queue.queueCopyPasteWan(ownerId, [jobId], 'still')
      await drainWorkers()
      const approved = (await urls())!
      assert.notEqual(approved.still_image_url, firstStill)
      assert.match(approved.still_image_url, new RegExp(`/monitor/${jobId}/wan-still-[0-9a-f]{8}\\.jpg$`))
      assert.equal(approved.motion_video_url, motionBefore)
      assert.equal(matteCalls().length, mattes)

      await m.db.query(`UPDATE copy_paste_wan_jobs SET status = 'approved' WHERE id = $1`, [jobId])
      await m.queue.queueCopyPasteWan(ownerId, [jobId], 'video')
      await drainWorkers()
      assert.equal((await jobRow(jobId)).status, 'done')

      const wanCalls = wavespeedPosts.slice(mine).filter(p => p.url.endsWith('/alibaba/wan-3.0/reference-to-video'))
      assert.equal(wanCalls.length, 1, 'exactly one paid Wan call')
      const body = wanCalls[0].body as { reference_images: string[]; reference_videos: string[] } & Record<string, unknown>
      const job = (await urls())!

      const sourceUrl = job.video_url
      assert.ok(await inkAt(sourceUrl) > 10_000, 'fixture sanity: the stored source reel carries the ink')
      const [characterRef, still] = body.reference_images
      assert.equal(await inkAt(characterRef), 0, 'character reference is ink-free')
      assert.equal(await inkAt(still), 0, 'characterized still is ink-free')
      assert.ok(!body.reference_videos.includes(sourceUrl), 'the raw source reel is not sent to Wan')
      for (const video of body.reference_videos) assert.equal(await inkAt(video), 0, `Wan reference video carries the source ink: ${video}`)

      // The intended references, in order: Image 1 identity, Image 2 the still
      // that was approved, Video 1 the scrubbed reel — and nothing else.
      assert.deepEqual(body.reference_images, [job.reference_image_url, job.still_image_url])
      assert.deepEqual(body.reference_videos, [job.motion_video_url])
      assert.match(job.motion_video_url!, new RegExp(`/monitor/${jobId}/wan-motion-[0-9a-f]{8}\\.mp4$`))
      // The remover matted the stored reel against a key-green background.
      const matte = matteCalls().at(-1)!.body
      assert.equal(matte.video, sourceUrl)
      assert.match(String(matte.background_image), new RegExp(`/monitor/${jobId}/matte-key\\.png$`))

      // Prompt and the rest of the body: no weight/strength or negative-prompt field exists on this API.
      assert.equal(body.prompt, WAN_MOTION_REFERENCE_PROMPT)
      assert.deepEqual(Object.keys(body).sort(), [
        'aspect_ratio', 'duration', 'enable_audio', 'enable_prompt_expansion', 'prompt',
        'reference_images', 'reference_videos', 'resolution',
      ])
      assert.equal(body.enable_prompt_expansion, false)
      assert.equal(body.resolution, '480p')

      // Motion is untouched: same frames, rate, length and sound as the source.
      const [src, motion] = [streamFacts(await localCopy(sourceUrl)), streamFacts(await localCopy(job.motion_video_url!))]
      assert.deepEqual(motion, src)
    } finally {
      Object.assign(served, prev)
    }
  })
})

describe('error classification', () => {
  it('maps resolver failures to the fix they need', async () => {
    const { classifyAcquireError, classifyWanError, WanJobError } = await import('./wan-jobs')
    const { EnqueueUrlsError } = await import('./enqueue-from-urls')
    assert.equal(classifyAcquireError(new EnqueueUrlsError('No valid Instagram reel links', 400)), 'INVALID_INPUT')
    assert.equal(classifyAcquireError(new EnqueueUrlsError('Could not fetch that reel. Apify could not fetch it (boom).', 502)), 'ACQUISITION_FAILED')
    assert.equal(classifyAcquireError(new EnqueueUrlsError('Could not fetch that reel. ... out of requests for this month (HTTP 429) ...', 502)), 'ACQUISITION_FAILED')
    assert.equal(classifyAcquireError(new EnqueueUrlsError('Could not fetch that reel. The reel could not be fetched by Apify or the download API, and we could not list it from the source profile either (private and age-restricted accounts often return nothing).', 502)), 'SOURCE_UNAVAILABLE')
    assert.equal(classifyWanError(new Error('Storage upload failed: 500')), 'STORAGE_FAILED')
    assert.equal(classifyWanError(new Error('No API key configured for: wavespeed_api_key')), 'REPLICATOR_UNAVAILABLE')
    assert.equal(classifyWanError(new Error('Wan 3.0 failed: bad input')), 'PROCESSING_FAILED')
    assert.equal(classifyWanError(new WanJobError('STALLED', 'x')), 'STALLED')
  })
})
