/**
 * Photo Replicator phase 2, end to end against a real Postgres
 * (TEST_DATABASE_URL — skipped without it), the real queue worker route and the
 * real Telegram webhook route. Only the outside world is faked: WaveSpeed,
 * Telegram, Supabase storage (a local HTTP server) and the Sheet (in memory).
 *
 * Sheet tick → job → Seedream + skin pass → Telegram preview → Approve /
 * Regenerate / Reject → Drive raw → archived, plus every retry and duplicate path.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import type { CellValue, SheetIO } from './viral-sheet'

const TEST_DB = process.env.TEST_DATABASE_URL
const CHAT = 424243

// ── Fake Sheet ───────────────────────────────────────────────────────────────

const HEADER = ['Slika', 'Pregled', 'Izvor', 'Dodato', 'Karakter', 'Format', 'Slajdova',
  'Dodatak prompta', 'Pošalji', 'Status', 'Job ID', 'Greška', 'Rezultat', 'Farma']
const COLS = 'ABCDEFGHIJKLMN'

class MemorySheet implements SheetIO {
  grid: string[][] = [[...HEADER]]
  writes: string[] = []
  reads = 0

  addRow(image: string, opts: { character?: string; format?: string; slides?: string; addition?: string; send?: boolean } = {}): number {
    this.grid.push([image, '=IMAGE(INDIRECT("A"&ROW()))', 'https://www.instagram.com/p/DPhoto123/?img_index=2', '2026-10-02 10:00 UTC',
      opts.character ?? '', opts.format ?? '', opts.slides ?? '', opts.addition ?? '', opts.send ? 'TRUE' : 'FALSE'])
    return this.grid.length
  }
  cell(row: number, col: string): string {
    return this.grid[row - 1]?.[COLS.indexOf(col)] ?? ''
  }
  set(row: number, col: string, value: string) {
    const r = this.grid[row - 1]
    r[COLS.indexOf(col)] = value
    for (let i = 0; i < r.length; i++) r[i] ??= ''
  }
  async readRows() {
    this.reads++
    return this.grid.map(r => r.map(c => c ?? ''))
  }
  async writeCells(updates: { a1: string; value: CellValue }[]) {
    for (const u of updates) {
      const m = u.a1.match(/^'Photo Replicator'!([A-Z])(\d+)$/)
      assert.ok(m, `bad a1 ${u.a1}`)
      assert.ok('IJKLMN'.includes(m[1]), `phase 2 writes only I–N, not ${m[1]}`)
      this.writes.push(u.a1)
      const v = typeof u.value === 'boolean' ? (u.value ? 'TRUE' : 'FALSE') : String(u.value)
      const row = this.grid[Number(m[2]) - 1] ?? (this.grid[Number(m[2]) - 1] = [])
      row[COLS.indexOf(m[1])] = v
      for (let i = 0; i < row.length; i++) row[i] ??= ''
    }
  }
  async applyValidation() {
    throw new Error('the sync must not touch validation')
  }
}

// ── Fake outside world ───────────────────────────────────────────────────────

const store = new Map<string, { body: Buffer; type: string }>()
const telegramCalls: { method: string; body: Record<string, unknown> }[] = []
const wavespeedPosts: { url: string; body: Record<string, unknown> }[] = []
const driveKicks: string[] = []
let wavespeedFail = false
let telegramFail = false
let served = { png: Buffer.alloc(0), ref: Buffer.alloc(0) }
let base = ''
let server: http.Server
const workerRuns = new Set<Promise<unknown>>()

type Mod = {
  sync: typeof import('./photo-sync')
  jobs: typeof import('./photo-jobs')
  db: typeof import('@/lib/db')
  webhook: typeof import('@/app/api/telegram/webhook/route')
  NextRequest: typeof import('next/server').NextRequest
}
let m: Mod
let ownerId = ''
let callbackSeq = 0

async function drainWorkers() {
  while (workerRuns.size) await Promise.allSettled([...workerRuns])
}

async function tick(sheet: MemorySheet) {
  const r = await m.sync.runPhotoReplicatorTick(sheet)
  await drainWorkers()
  return r
}

async function job(id: string) {
  return (await m.jobs.getPhotoJob(id))!
}

/** A photo the Clipper stored for the owner (Phase 1 path), served by the fake storage. */
async function clippedPhoto(): Promise<string> {
  // Noise, so every call is a different photo (solid colours can JPEG-encode to identical bytes).
  const img = await sharp(randomBytes(400 * 500 * 3), { raw: { width: 400, height: 500, channels: 3 } }).jpeg().toBuffer()
  const sha = createHash('sha256').update(img).digest('hex')
  store.set(`photo-replicator/${ownerId}/${sha}.jpg`, { body: img, type: 'image/jpeg' })
  return `${base}/storage/v1/object/public/generations/photo-replicator/${ownerId}/${sha}.jpg`
}

/** Taps a preview button through the real webhook route. */
async function tap(data: string, messageId = 7) {
  const req = new m.NextRequest('http://localhost/api/telegram/webhook?secret=test-cron', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: ++callbackSeq, callback_query: { id: `cb${callbackSeq}`, data, message: { message_id: messageId, chat: { id: CHAT } } } }),
  })
  const res = await m.webhook.POST(req)
  assert.equal(res.status, 200)
  await drainWorkers()
  const answer = [...telegramCalls].reverse().find(c => c.method === 'answerCallbackQuery')
  return String(answer?.body.text ?? '')
}

/** What the Drive worker does once it has uploaded every queued file. */
async function driveUploaded(jobId: string) {
  await m.db.query(
    `UPDATE drive_exports SET status = 'done', drive_file_id = 'drv-' || substr(md5(id::text), 1, 12), finished_at = now()
      WHERE source_type = 'photo_replicator' AND source_id = $1`,
    [jobId],
  )
}

const seedreamCalls = () => wavespeedPosts.filter(p => p.url.includes('seedream'))
const skinCalls = () => wavespeedPosts.filter(p => p.url.includes('z-image-turbo/image-to-image'))

describe('Photo Replicator phase 2 — Sheet → generation → Telegram → Drive raw', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
    served = {
      png: await sharp({ create: { width: 896, height: 1120, channels: 3, background: { r: 200, g: 150, b: 120 } } }).png().toBuffer(),
      ref: await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer(),
    }
    server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url.startsWith('/storage/v1/object/generations/')) {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          store.set(url.replace('/storage/v1/object/generations/', ''), { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? '') })
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        })
        return
      }
      if (url.startsWith('/storage/v1/object/public/generations/')) {
        const f = store.get(url.replace('/storage/v1/object/public/generations/', ''))
        if (!f) return void res.writeHead(404).end()
        return void res.writeHead(200, { 'content-type': f.type }).end(f.body)
      }
      if (url === '/ws/out.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(served.png)
      if (url === '/ref.jpg') return void res.writeHead(200, { 'content-type': 'image/jpeg' }).end(served.ref)
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
      OWNER_EMAIL: `owner-${randomUUID()}@photo-test.local`,
      PHOTO_REPLICATOR_SYNC_ENABLED: 'true',
    })

    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('http://queue.internal/api/queue/process/')) {
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
      if (url.startsWith('http://queue.internal/api/cron/drive-archive')) {
        driveKicks.push(url)
        return new Response('{}')
      }
      if (url.includes('api.wavespeed.ai')) {
        if (init?.method === 'POST') {
          wavespeedPosts.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} })
          if (wavespeedFail) return Response.json({ code: 500, message: 'model overloaded' })
          return Response.json({ code: 200, data: { id: `req-${wavespeedPosts.length}` } })
        }
        return Response.json({ code: 200, data: { status: 'completed', outputs: [`${base}/ws/out.png`] } })
      }
      if (url.includes('api.telegram.org')) {
        const method = url.split('/').pop()!
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        telegramCalls.push({ method, body })
        if (telegramFail && (method === 'sendPhoto' || method === 'sendMediaGroup')) {
          return Response.json({ ok: false, description: 'Bad Gateway' })
        }
        if (method === 'sendMediaGroup') {
          return Response.json({ ok: true, result: (body.media as unknown[]).map((_, i) => ({ message_id: 100 + i })) })
        }
        return Response.json({ ok: true, result: { message_id: telegramCalls.length } })
      }
      return realFetch(input, init)
    }) as typeof fetch

    m = {
      sync: await import('./photo-sync'),
      jobs: await import('./photo-jobs'),
      db: await import('@/lib/db'),
      webhook: await import('@/app/api/telegram/webhook/route'),
      NextRequest: (await import('next/server')).NextRequest,
    }

    const owner = await m.db.one<{ id: string }>(
      `INSERT INTO users (email, display_name, role, password_hash, telegram_chat_id, drive_auto_archive, google_refresh_token)
       VALUES ($1, 'Owner', 'admin', 'x', $2, true, 'test-refresh') RETURNING id`,
      [process.env.OWNER_EMAIL, CHAT],
    )
    ownerId = owner!.id
    for (const [name, ref, prompt] of [
      ['Tiana Normal', `${base}/ref.jpg`, 'big breasts, remove tattoos'],
      ['Diana Goth', `${base}/ref.jpg`, 'change outfit into goth'],
      ['No Photo', null, null],
    ] as const) {
      await m.db.query(`INSERT INTO characters (user_id, name, reference_image_url, wan_prompt) VALUES ($1, $2, $3, $4)`, [ownerId, name, ref, prompt])
    }
  })

  after(async () => {
    await drainWorkers()
    await m?.db.query(`DELETE FROM drive_exports WHERE user_id = $1`, [ownerId]).catch(() => {})
    await m?.db.query(`DELETE FROM generation_queue WHERE user_id = $1`, [ownerId]).catch(() => {})
    await m?.db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => {})
    server?.close()
    await (globalThis as { __xmDbPool?: { end(): Promise<void> } }).__xmDbPool?.end()
  })

  it('off unless PHOTO_REPLICATOR_SYNC_ENABLED — the tab is not even read', async () => {
    const sheet = new MemorySheet()
    sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    process.env.PHOTO_REPLICATOR_SYNC_ENABLED = 'false'
    try {
      const r = await tick(sheet)
      assert.equal(r.skipped, 'disabled')
      assert.equal(sheet.reads, 0)
      assert.equal(sheet.writes.length, 0)
    } finally {
      process.env.PHOTO_REPLICATOR_SYNC_ENABLED = 'true'
    }
  })

  it('rows that cannot be sent are unticked with the reason — nothing queued, nothing paid', async () => {
    const sheet = new MemorySheet()
    const good = await clippedPhoto()
    const rows = {
      noImage: sheet.addRow('', { character: 'Tiana Normal', format: 'Post', send: true }),
      foreign: sheet.addRow('https://scontent.cdninstagram.com/v/x.jpg', { character: 'Tiana Normal', format: 'Post', send: true }),
      otherUser: sheet.addRow(good.replace(ownerId, randomUUID()), { character: 'Tiana Normal', format: 'Post', send: true }),
      noCharacter: sheet.addRow(good, { format: 'Post', send: true }),
      noPhotoChar: sheet.addRow(good, { character: 'No Photo', format: 'Post', send: true }),
      noFormat: sheet.addRow(good, { character: 'Tiana Normal', send: true }),
      badFormat: sheet.addRow(good, { character: 'Tiana Normal', format: 'Reel', send: true }),
      badSlides: sheet.addRow(good, { character: 'Tiana Normal', format: 'Carousel', slides: '5', send: true }),
      notTicked: sheet.addRow(good, { character: 'Tiana Normal', format: 'Post' }),
    }
    const before = wavespeedPosts.length
    const r = await tick(sheet)
    assert.equal(r.claimed, 0)
    assert.equal(r.rejected, 8)
    for (const [name, row] of Object.entries(rows)) {
      if (name === 'notTicked') {
        assert.equal(sheet.cell(row, 'J'), '')
        continue
      }
      assert.equal(sheet.cell(row, 'I'), 'FALSE', name)
      assert.equal(sheet.cell(row, 'J'), '⚠ Nije poslato', name)
      assert.match(sheet.cell(row, 'L'), /^INVALID_INPUT: /, name)
      assert.equal(sheet.cell(row, 'K'), '', name)
    }
    assert.match(sheet.cell(rows.badSlides, 'L'), /2 ili 3/)
    assert.match(sheet.cell(rows.noPhotoChar, 'L'), /nema referentnu fotografiju/)
    assert.equal(wavespeedPosts.length, before)
    const n = await m.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM photo_replicator_jobs WHERE user_id = $1`, [ownerId])
    assert.equal(n!.n, 0)
  })

  it('post: tick → Seedream [source, reference] + skin pass at 4:5 → JPEG in storage → preview; Approve → Drive raw → archived', async () => {
    const sheet = new MemorySheet()
    const photo = await clippedPhoto()
    const row = sheet.addRow(photo, { character: 'tiana normal', format: 'Post', addition: 'add a coffee cup', send: true })
    const seedBefore = seedreamCalls().length
    const skinBefore = skinCalls().length
    telegramCalls.length = 0

    const r = await tick(sheet)
    assert.equal(r.claimed, 1)
    assert.equal(sheet.cell(row, 'I'), 'FALSE')
    const jobId = sheet.cell(row, 'K')
    assert.match(jobId, /^[0-9a-f-]{36}$/)

    let j = await job(jobId)
    assert.equal(j.status, 'awaiting_approval')
    assert.equal(j.attempt, 1)
    assert.equal(j.format, 'post')
    assert.equal(j.slides, 1)
    assert.equal(j.source_link, 'https://www.instagram.com/p/DPhoto123/?img_index=2')

    // Exactly one Seedream edit (source photo first, then the reference) and one skin pass.
    const seed = seedreamCalls().slice(seedBefore)
    assert.equal(seed.length, 1)
    assert.deepEqual(seed[0].body.images, [photo, `${base}/ref.jpg`])
    assert.equal(seed[0].body.aspect_ratio, '4:5')
    const prompt = String(seed[0].body.prompt)
    assert.match(prompt, /^Image 1 is the scene reference, image 2 is the identity reference\./)
    assert.match(prompt, /big breasts, remove tattoos\nadd a coffee cup$/)
    const skin = skinCalls().slice(skinBefore)
    assert.equal(skin.length, 1)
    assert.equal(skin[0].body.size, '896*1120')
    assert.equal(wavespeedPosts.filter(p => /wan/i.test(p.url)).length, 0, 'no Wan call')

    // Stored as a real JPEG under the job, distinct per attempt.
    assert.equal(j.result!.length, 1)
    assert.equal(j.result![0].url, `${base}/storage/v1/object/public/generations/photo-replicator/jobs/${jobId}/a1-01.jpg`)
    const stored = store.get(`photo-replicator/jobs/${jobId}/a1-01.jpg`)!
    assert.equal(stored.type, 'image/jpeg')
    const meta = await sharp(stored.body).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 896, 1120])

    // Preview: one photo with the three buttons for this attempt.
    const sent = telegramCalls.filter(c => c.method === 'sendPhoto')
    assert.equal(sent.length, 1)
    assert.equal(String(sent[0].body.chat_id), String(CHAT))
    assert.equal(sent[0].body.photo, j.result![0].url)
    assert.deepEqual((sent[0].body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0].map(b => b.callback_data),
      [`phok:${jobId}:1`, `phre:${jobId}:1`, `phno:${jobId}:1`])
    assert.match(String(sent[0].body.caption), /Tiana Normal · Post/)
    assert.ok(j.preview_sent_at)

    await tick(sheet)
    assert.equal(sheet.cell(row, 'J'), '⏸ Čeka Approve (Telegram)')
    assert.equal(sheet.cell(row, 'M'), j.result![0].url)
    assert.equal(sheet.cell(row, 'L'), '')

    // Nothing reaches Drive before Approve.
    const none = await m.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM drive_exports WHERE source_id = $1`, [jobId])
    assert.equal(none!.n, 0)

    // Ticking again while it waits: no second job, no second generation.
    sheet.set(row, 'I', 'TRUE')
    const again = await tick(sheet)
    assert.equal(again.claimed + again.retried, 0)
    assert.equal(again.duplicates, 1)
    assert.match(sheet.cell(row, 'L'), /^DUPLICATE_JOB: ovaj job je već u obradi/)
    assert.equal(seedreamCalls().length, seedBefore + 1)

    // Approve, then the same tap again (double click / redelivered update).
    assert.equal(await tap(`phok:${jobId}:1`), 'Approved')
    assert.equal(await tap(`phok:${jobId}:1`), 'Already handled')
    assert.equal(await tap(`phno:${jobId}:1`), 'Already handled')
    j = await job(jobId)
    assert.equal(j.status, 'archiving')
    assert.ok(j.approved_at)
    const exports = await m.db.rows<{ filename: string; kind: string; stage: string; section: string; character_key: string; series_folder: string; source_url: string; status: string }>(
      `SELECT filename, kind, stage, section, character_key, series_folder, source_url, status FROM drive_exports WHERE source_type = 'photo_replicator' AND source_id = $1`, [jobId])
    assert.equal(exports.length, 1)
    const short = jobId.replace(/-/g, '').slice(0, 8)
    assert.match(exports[0].filename, new RegExp(`^pr_${short}_01_[0-9a-f]{4}\\.jpg$`))
    assert.deepEqual([exports[0].kind, exports[0].stage, exports[0].section, exports[0].character_key, exports[0].series_folder, exports[0].source_url],
      ['posts', 'raw', 'IGreplicator', 'tiana_normal', '', j.result![0].url])

    await tick(sheet)
    assert.equal(sheet.cell(row, 'J'), '● Upload na Drive')
    await driveUploaded(jobId)
    const t = await tick(sheet)
    assert.equal(t.archives?.archived, 1)
    j = await job(jobId)
    assert.equal(j.status, 'archived')
    assert.ok(j.archived_at)
    assert.equal(sheet.cell(row, 'J'), '✓ Na Drive-u (raw)')
    assert.equal(sheet.cell(row, 'N'), '◷ Čeka farmu')

    // Finished: ticking again adds nothing; another character starts a new job.
    sheet.set(row, 'I', 'TRUE')
    const done = await tick(sheet)
    assert.equal(done.duplicates, 1)
    assert.equal(sheet.cell(row, 'K'), jobId)
    assert.match(sheet.cell(row, 'L'), /^DUPLICATE_JOB: već završeno/)
    sheet.set(row, 'E', 'Diana Goth')
    sheet.set(row, 'I', 'TRUE')
    const other = await tick(sheet)
    assert.equal(other.claimed, 1)
    assert.notEqual(sheet.cell(row, 'K'), jobId)
    assert.match(String(seedreamCalls().at(-1)!.body.prompt), /change outfit into goth\nadd a coffee cup$/)
  })

  it('carousel: 3 slides in order — base + 2 pose variants edited off the raw base; album + one approval message; Drive set folder', async () => {
    const sheet = new MemorySheet()
    const photo = await clippedPhoto()
    const row = sheet.addRow(photo, { character: 'Tiana Normal', format: 'Carousel', send: true }) // empty Slajdova = 3
    const seedBefore = seedreamCalls().length
    const skinBefore = skinCalls().length
    telegramCalls.length = 0

    await tick(sheet)
    const jobId = sheet.cell(row, 'K')
    const j = await job(jobId)
    assert.equal(j.status, 'awaiting_approval')
    assert.equal(j.slides, 3)
    assert.equal(j.result!.length, 3)
    assert.deepEqual(j.result!.map(s => s.url.split('/').pop()), ['a1-01.jpg', 'a1-02.jpg', 'a1-03.jpg'])

    const seed = seedreamCalls().slice(seedBefore)
    assert.equal(seed.length, 3)
    const rawBase = `${base}/storage/v1/object/public/generations/photo-replicator/jobs/${jobId}/a1-base-raw.jpg`
    assert.deepEqual(seed[0].body.images, [photo, `${base}/ref.jpg`])
    for (const v of seed.slice(1)) {
      assert.deepEqual(v.body.images, [rawBase], 'variants edit the raw base only')
      assert.equal(v.body.aspect_ratio, '4:5')
      assert.match(String(v.body.prompt), /^Keep the exact same person, face, identity, outfit, background and environment/)
    }
    assert.equal(skinCalls().length - skinBefore, 3, 'one skin pass per final slide, never on the raw base')
    assert.ok(skinCalls().slice(skinBefore).every(c => c.body.image !== rawBase || c === skinCalls()[skinBefore]))

    const album = telegramCalls.filter(c => c.method === 'sendMediaGroup')
    assert.equal(album.length, 1)
    assert.deepEqual((album[0].body.media as { media: string }[]).map(x => x.media), j.result!.map(s => s.url))
    const buttons = telegramCalls.filter(c => c.method === 'sendMessage' && c.body.reply_markup)
    assert.equal(buttons.length, 1)
    assert.deepEqual(j.preview_message_ids!.slice(0, 3), [100, 101, 102])

    await tick(sheet)
    assert.equal(sheet.cell(row, 'M'), j.result!.map(s => s.url).join('\n'))

    const messageId = j.preview_message_ids![3]
    assert.equal(await tap(`phok:${jobId}:1`, messageId), 'Approved')
    // The buttons sit on a text message: its text is edited, not a caption.
    assert.ok(telegramCalls.some(c => c.method === 'editMessageText' && c.body.message_id === messageId))
    const exports = await m.db.rows<{ filename: string; series_folder: string; kind: string; source_url: string }>(
      `SELECT filename, series_folder, kind, source_url FROM drive_exports WHERE source_type = 'photo_replicator' AND source_id = $1 ORDER BY filename`, [jobId])
    const short = jobId.replace(/-/g, '').slice(0, 8)
    assert.equal(exports.length, 3)
    assert.ok(exports.every(e => e.series_folder === `pr_${short}_3s` && e.kind === 'carousels'))
    assert.deepEqual(exports.map(e => e.filename.slice(0, 3)), ['01_', '02_', '03_'])
    assert.deepEqual(exports.map(e => e.source_url), j.result!.map(s => s.url), 'file order = slide order')

    // Two of three uploaded: still archiving — a set is complete or it is nothing.
    await m.db.query(`UPDATE drive_exports SET status = 'done', drive_file_id = 'x' || id WHERE source_id = $1 AND filename LIKE '0[12]_%'`, [jobId])
    await tick(sheet)
    assert.equal((await job(jobId)).status, 'archiving')
    await driveUploaded(jobId)
    await tick(sheet)
    assert.equal((await job(jobId)).status, 'archived')

    // Slajdova = 2.
    const two = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Carousel', slides: '2', send: true })
    await tick(sheet)
    const j2 = await job(sheet.cell(two, 'K'))
    assert.equal(j2.slides, 2)
    assert.equal(j2.result!.length, 2)
  })

  it('Regenerate is bounded: 3 generations per job, old buttons die, no Regenerate on the last one', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Story', send: true })
    await tick(sheet)
    const jobId = sheet.cell(row, 'K')
    let j = await job(jobId)
    assert.equal(seedreamCalls().at(-1)!.body.aspect_ratio, '9:16')
    assert.equal(skinCalls().at(-1)!.body.size, '756*1344')
    const firstUrl = j.result![0].url

    telegramCalls.length = 0
    assert.equal(await tap(`phre:${jobId}:1`), 'Regenerating')
    assert.equal(await tap(`phre:${jobId}:1`), 'Already handled')
    j = await job(jobId)
    assert.equal(j.attempt, 2)
    assert.equal(j.status, 'awaiting_approval')
    assert.notEqual(j.result![0].url, firstUrl, 'a new file per attempt')
    // The first preview's Approve no longer does anything.
    assert.equal(await tap(`phok:${jobId}:1`), 'Already handled')
    assert.equal((await job(jobId)).status, 'awaiting_approval')

    assert.equal(await tap(`phre:${jobId}:2`), 'Regenerating')
    j = await job(jobId)
    assert.equal(j.attempt, 3)
    const last = [...telegramCalls].reverse().find(c => c.method === 'sendPhoto')!
    const actions = (last.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0].map(b => b.callback_data.split(':')[0])
    assert.deepEqual(actions, ['phok', 'phno'])
    const seedCount = seedreamCalls().length
    assert.equal(await tap(`phre:${jobId}:3`), 'Already handled')
    assert.equal(seedreamCalls().length, seedCount, 'no 4th generation')
    assert.equal((await job(jobId)).status, 'awaiting_approval')

    // Even a queue job that reaches the worker at the limit is refused.
    await m.db.query(`UPDATE photo_replicator_jobs SET status = 'queued' WHERE id = $1`, [jobId])
    await m.jobs.queuePhotoGeneration(ownerId, jobId)
    await drainWorkers()
    j = await job(jobId)
    assert.deepEqual([j.status, j.error_code, j.attempt], ['failed', 'REGEN_LIMIT', 3])
    assert.equal(seedreamCalls().length, seedCount)
  })

  it('Reject: nothing reaches Drive; ticking again starts a new job', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    await tick(sheet)
    const jobId = sheet.cell(row, 'K')
    assert.equal(await tap(`phno:${jobId}:1`), 'Rejected')
    assert.equal(await tap(`phok:${jobId}:1`), 'Already handled')
    const j = await job(jobId)
    assert.equal(j.status, 'rejected')
    const n = await m.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM drive_exports WHERE source_id = $1`, [jobId])
    assert.equal(n!.n, 0)
    await tick(sheet)
    assert.equal(sheet.cell(row, 'J'), '✖ Odbijeno — čekiraj Pošalji za novi job')
    assert.equal(sheet.cell(row, 'M'), '')

    sheet.set(row, 'I', 'TRUE')
    const r = await tick(sheet)
    assert.equal(r.claimed, 1)
    const next = sheet.cell(row, 'K')
    assert.notEqual(next, jobId)
    assert.equal((await job(next)).status, 'awaiting_approval')
  })

  it('duplicate rows: the same photo + character + format in two rows → one job', async () => {
    const sheet = new MemorySheet()
    const photo = await clippedPhoto()
    const a = sheet.addRow(photo, { character: 'Tiana Normal', format: 'Post', send: true })
    const b = sheet.addRow(photo, { character: 'Tiana Normal', format: 'post', send: true })
    const before = seedreamCalls().length
    const r = await tick(sheet)
    assert.equal(r.claimed, 1)
    assert.equal(r.duplicates, 1)
    assert.equal(sheet.cell(a, 'K'), sheet.cell(b, 'K'))
    assert.match(sheet.cell(b, 'L'), /^DUPLICATE_JOB: /)
    assert.equal(seedreamCalls().length, before + 1)
  })

  it('at most 5 paid claims per tick — the rest stay ticked for the next tick', async () => {
    const sheet = new MemorySheet()
    const rowsAdded: number[] = []
    for (let i = 0; i < 6; i++) rowsAdded.push(sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true }))
    const r = await tick(sheet)
    assert.equal(r.claimed, 5)
    assert.equal(sheet.cell(rowsAdded[5], 'I'), 'TRUE')
    assert.equal(sheet.cell(rowsAdded[5], 'K'), '')
    const r2 = await tick(sheet)
    assert.equal(r2.claimed, 1)
  })

  it('a failed generation fails visibly, is never re-run by the queue, and Pošalji retries the same job', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    wavespeedFail = true
    try {
      await tick(sheet)
    } finally {
      wavespeedFail = false
    }
    const jobId = sheet.cell(row, 'K')
    let j = await job(jobId)
    assert.deepEqual([j.status, j.error_code, j.attempt], ['failed', 'GENERATION_FAILED', 1])
    const q = await m.db.rows<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM generation_queue WHERE input->>'photoJobId' = $1`, [jobId])
    assert.deepEqual(q, [{ status: 'failed', attempts: 1, max_attempts: 1 }], 'no automatic re-run')
    await tick(sheet)
    assert.equal(sheet.cell(row, 'J'), '⚠ Greška — čekiraj Pošalji za retry')
    assert.match(sheet.cell(row, 'L'), /^GENERATION_FAILED: /)

    sheet.set(row, 'I', 'TRUE')
    const r = await tick(sheet)
    assert.equal(r.retried, 1)
    assert.equal(sheet.cell(row, 'K'), jobId, 'same job')
    j = await job(jobId)
    assert.deepEqual([j.status, j.attempt], ['awaiting_approval', 2])
  })

  it('a Telegram failure after a good generation keeps the result: Pošalji re-sends the preview without paying again', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    telegramFail = true
    try {
      await tick(sheet)
    } finally {
      telegramFail = false
    }
    const jobId = sheet.cell(row, 'K')
    let j = await job(jobId)
    assert.deepEqual([j.status, j.error_code], ['failed', 'PREVIEW_FAILED'])
    assert.equal(j.result!.length, 1)

    const paid = wavespeedPosts.length
    telegramCalls.length = 0
    sheet.set(row, 'I', 'TRUE')
    const r = await tick(sheet)
    assert.equal(r.resumed, 1)
    assert.equal(wavespeedPosts.length, paid, 'no generation')
    j = await job(jobId)
    assert.deepEqual([j.status, j.attempt], ['awaiting_approval', 1])
    assert.equal(telegramCalls.filter(c => c.method === 'sendPhoto').length, 1)
    assert.equal(await tap(`phok:${jobId}:1`), 'Approved')
  })

  it('Drive off at Approve: approved result kept; Pošalji re-archives without generating', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    await tick(sheet)
    const jobId = sheet.cell(row, 'K')
    await m.db.query(`UPDATE users SET drive_auto_archive = false WHERE id = $1`, [ownerId])
    try {
      assert.equal(await tap(`phok:${jobId}:1`), 'Approved')
    } finally {
      await m.db.query(`UPDATE users SET drive_auto_archive = true WHERE id = $1`, [ownerId])
    }
    let j = await job(jobId)
    assert.deepEqual([j.status, j.error_code], ['failed', 'DRIVE_UNAVAILABLE'])
    assert.ok(j.approved_at)

    const paid = wavespeedPosts.length
    sheet.set(row, 'I', 'TRUE')
    const r = await tick(sheet)
    assert.equal(r.resumed, 1)
    assert.equal(wavespeedPosts.length, paid)
    j = await job(jobId)
    assert.equal(j.status, 'archiving')

    // A file the Drive worker gave up on → DRIVE_FAILED → Pošalji queues it again from zero.
    await m.db.query(`UPDATE drive_exports SET status = 'failed', attempts = 5, finished_at = now(), error = 'boom' WHERE source_id = $1`, [jobId])
    await tick(sheet)
    j = await job(jobId)
    assert.deepEqual([j.status, j.error_code], ['failed', 'DRIVE_FAILED'])
    sheet.set(row, 'I', 'TRUE')
    await tick(sheet)
    const ex = await m.db.one<{ status: string; attempts: number }>(`SELECT status, attempts FROM drive_exports WHERE source_id = $1`, [jobId])
    assert.deepEqual(ex, { status: 'pending', attempts: 0 })
    assert.equal((await job(jobId)).status, 'archiving')
    assert.equal(wavespeedPosts.length, paid)
  })

  it('an approval that crashed before its Drive step is finished by the tick', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post', send: true })
    await tick(sheet)
    const jobId = sheet.cell(row, 'K')
    await m.db.query(`UPDATE photo_replicator_jobs SET status = 'approved', approved_at = now(), updated_at = now() - interval '5 minutes' WHERE id = $1`, [jobId])
    const r = await tick(sheet)
    assert.equal(r.archives?.resumed, 1)
    assert.equal((await job(jobId)).status, 'archiving')
  })

  it('a worker that died mid-generation: the stale sweep fails the job STALLED, never re-runs it', async () => {
    const sheet = new MemorySheet()
    const row = sheet.addRow(await clippedPhoto(), { character: 'Tiana Normal', format: 'Post' })
    const created = await m.jobs.createPhotoJob({
      userId: ownerId, chatId: CHAT, characterId: (await m.db.one<{ id: string }>(`SELECT id FROM characters WHERE user_id = $1 AND name = 'Tiana Normal'`, [ownerId]))!.id,
      sourceUrl: sheet.cell(row, 'A'), sourceSha256: m.jobs.photoSourceSha(sheet.cell(row, 'A'), ownerId)!, sourceLink: null,
      format: 'post', slides: 1, promptAddition: null, sheetRow: row,
    })
    await m.db.query(`UPDATE photo_replicator_jobs SET status = 'generating', attempt = 1 WHERE id = $1`, [created.jobId])
    const q = await m.db.one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items, max_attempts, status, attempts, started_at)
       VALUES ($1, 'photo_replicator', $2, 1, 1, 'processing', 1, now() - interval '30 minutes') RETURNING id`,
      [ownerId, JSON.stringify({ photoJobId: created.jobId })])
    assert.equal(await m.jobs.failStalePhotoJob(q!.id, 'Job stalled'), 1)
    const j = await job(created.jobId)
    assert.deepEqual([j.status, j.error_code], ['failed', 'STALLED'])
  })
})
