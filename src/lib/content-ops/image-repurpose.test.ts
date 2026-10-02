/**
 * The farm's image repurpose (Photo Replicator phase 2E) through the real
 * routes, the real PAT check and the real queue worker (Postgres:
 * TEST_DATABASE_URL — skipped without it). ffmpeg runs for real; only storage
 * is a local HTTP server.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'

const TEST_DB = process.env.TEST_DATABASE_URL

const store = new Map<string, { body: Buffer; type: string }>()
let base = ''
let server: http.Server
let ownerId = ''
let token = ''

type Mod = {
  db: typeof import('@/lib/db')
  order: typeof import('@/app/api/content-ops/image-repurpose/route')
  status: typeof import('@/app/api/content-ops/image-repurpose/[id]/route')
  characters: typeof import('@/app/api/content-ops/characters/route')
  process: typeof import('@/app/api/queue/process/[id]/route')
  lib: typeof import('./image-repurpose')
  NextRequest: typeof import('next/server').NextRequest
}
let m: Mod

const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

async function order(body: unknown) {
  const res = await m.order.POST(new m.NextRequest('http://localhost/api/content-ops/image-repurpose', { method: 'POST', headers: auth(), body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function status(id: string) {
  const res = await m.status.GET(new m.NextRequest(`http://localhost/api/content-ops/image-repurpose/${id}`, { headers: auth() }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() as { status: string; total: number; done: number; format: string; slides: number; sets: (string[] | string)[] } }
}

/** What the tick does: claim the pending job and run the worker route. */
async function runWorker(id: string) {
  await m.db.query(`UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1 WHERE id=$1 AND status='pending'`, [id])
  const res = await m.process.POST(new m.NextRequest(`http://localhost/api/queue/process/${id}`, { method: 'POST', headers: { 'x-cron-secret': 'test-cron' } }), { params: Promise.resolve({ id }) } as never)
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
}

async function storedJpeg(url: string) {
  const f = store.get(url.replace(`${base}/storage/v1/object/public/generations/`, ''))
  assert.ok(f, `stored ${url}`)
  return f
}

/** An approved photo job's archived slides: storage copies + drive_exports rows marked uploaded. */
async function archivedSet(slides: Buffer[], format: 'post' | 'story' | 'carousel') {
  const jobId = randomUUID()
  const ids: string[] = []
  for (const [i, img] of slides.entries()) {
    const path = `photo-replicator/jobs/${jobId}/a1-0${i + 1}.jpg`
    store.set(path, { body: img, type: 'image/jpeg' })
    const url = `${base}/storage/v1/object/public/generations/${path}`
    const driveId = `drv${randomBytes(8).toString('hex')}`
    await m.db.query(
      `INSERT INTO drive_exports (user_id, source_type, source_id, source_url, url_hash, filename, mime_type, character_key, kind, stage, status, drive_file_id, finished_at)
       VALUES ($1, 'photo_replicator', $2, $3, $4, $5, 'image/jpeg', 'tiana_normal', $6, 'raw', 'done', $7, now())`,
      [ownerId, jobId, url, createHash('sha256').update(url).digest('hex'), `0${i + 1}_abcd.jpg`, format === 'carousel' ? 'carousels' : format === 'post' ? 'posts' : 'stories', driveId],
    )
    ids.push(driveId)
  }
  return { jobId, ids }
}

const photo = async (seedColour: number) =>
  sharp({ create: { width: 896, height: 1120, channels: 3, background: { r: seedColour, g: 120, b: 60 } } })
    .composite([{ input: await sharp(randomBytes(200 * 200 * 3), { raw: { width: 200, height: 200, channels: 3 } }).png().toBuffer(), top: 300, left: 300 }])
    .jpeg().toBuffer()

describe('content-ops image repurpose (farm contract)', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
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
      res.writeHead(404).end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    Object.assign(process.env, {
      DATABASE_URL: TEST_DB, SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'test', CRON_SECRET: 'test-cron',
      INTERNAL_BASE_URL: 'http://queue.internal',
    })
    const realFetch = globalThis.fetch
    // The ready/ archive kick is the only internal call; Drive itself is never reached here.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('http://queue.internal/')) return new Response('{}')
      return realFetch(input, init)
    }) as typeof fetch

    m = {
      db: await import('@/lib/db'),
      order: await import('@/app/api/content-ops/image-repurpose/route'),
      status: await import('@/app/api/content-ops/image-repurpose/[id]/route'),
      characters: await import('@/app/api/content-ops/characters/route'),
      process: await import('@/app/api/queue/process/[id]/route'),
      lib: await import('./image-repurpose'),
      NextRequest: (await import('next/server')).NextRequest,
    }
    const u = await m.db.one<{ id: string }>(
      `INSERT INTO users (email, display_name, role, password_hash, drive_auto_archive, google_refresh_token)
       VALUES ($1, 'Farm test', 'chatter', 'x', true, 'test-refresh') RETURNING id`,
      [`farm-${randomUUID().slice(0, 8)}@photo-test.local`],
    )
    ownerId = u!.id
    token = `xmpat_${randomBytes(24).toString('base64url')}`
    await m.db.query(`INSERT INTO personal_access_tokens (user_id, token_hash, label) VALUES ($1, $2, 'Farm (Mac)')`,
      [ownerId, createHash('sha256').update(token).digest('hex')])
    await m.db.query(`INSERT INTO characters (user_id, name, reference_image_url) VALUES ($1, 'Tiana Normal', 'https://x/ref.jpg')`, [ownerId])
  })

  after(async () => {
    await m?.db.query(`DELETE FROM drive_exports WHERE user_id = $1`, [ownerId]).catch(() => {})
    await m?.db.query(`DELETE FROM generation_queue WHERE user_id = $1`, [ownerId]).catch(() => {})
    await m?.db.query(`DELETE FROM drive_folders WHERE user_id = $1`, [ownerId]).catch(() => {})
    await m?.db.query(`DELETE FROM users WHERE id = $1`, [ownerId]).catch(() => {})
    server?.close()
    await (globalThis as { __xmDbPool?: { end(): Promise<void> } }).__xmDbPool?.end()
  })

  it('needs a token, and refuses malformed orders', async () => {
    const res = await m.order.POST(new m.NextRequest('http://localhost/api/content-ops/image-repurpose', { method: 'POST', body: '{}' }))
    assert.equal(res.status, 401)
    for (const bad of [
      {}, { driveFileIds: ['short'], format: 'post', count: 1 },
      { driveFileIds: ['abcdefghij12'], format: 'reel', count: 1 },
      { driveFileIds: ['abcdefghij12', 'abcdefghij13'], format: 'post', count: 1 },
      { driveFileIds: ['abcdefghij12'], format: 'carousel', count: 1 },
      { driveFileIds: ['abcdefghij12', 'abcdefghij12'], format: 'carousel', count: 1 },
      { driveFileIds: ['abcdefghij12'], format: 'post', count: 0 },
      { driveFileIds: ['abcdefghij12'], format: 'post', count: 21 },
    ]) {
      assert.equal((await order(bad)).status, 400, JSON.stringify(bad))
    }
  })

  it('carousel: one set per target, slides in order, the same seed across a set, different targets differ; re-order reuses the job', async () => {
    // Slides 1 and 2 are the same picture: with one seed per target they must come out identical.
    const same = await photo(200)
    const { jobId: photoJobId, ids } = await archivedSet([same, same, await photo(20)], 'carousel')
    const placed = await order({ driveFileIds: ids, format: 'carousel', count: 3, characterKey: 'tiana_normal' })
    assert.equal(placed.status, 200)
    assert.equal(placed.body.photoJobId, photoJobId)
    assert.equal(placed.body.reused, false)
    const jobId = String(placed.body.jobId)

    const again = await order({ driveFileIds: ids, format: 'carousel', count: 3, characterKey: 'tiana_normal' })
    assert.deepEqual([again.body.jobId, again.body.reused], [jobId, true])
    // Another slide order is another set.
    const reordered = await order({ driveFileIds: [ids[1], ids[0], ids[2]], format: 'carousel', count: 3 })
    assert.notEqual(reordered.body.jobId, jobId)
    await m.db.query(`UPDATE generation_queue SET status = 'cancelled' WHERE id = $1`, [reordered.body.jobId])

    await runWorker(jobId)
    const s = await status(jobId)
    assert.equal(s.body.status, 'done')
    assert.deepEqual([s.body.total, s.body.done, s.body.format, s.body.slides], [3, 3, 'carousel', 3])
    assert.equal(s.body.sets.length, 3)
    const digest = async (url: string) => createHash('sha256').update((await storedJpeg(url)).body).digest('hex')
    const sets = s.body.sets as string[][]
    for (const [t, set] of sets.entries()) {
      assert.equal(set.length, 3)
      assert.deepEqual(set.map(u => u.split('/').pop()), [`t${t + 1}_s1.jpg`, `t${t + 1}_s2.jpg`, `t${t + 1}_s3.jpg`])
      const meta = await sharp((await storedJpeg(set[0])).body).metadata()
      assert.equal(meta.format, 'jpeg')
      assert.equal(await digest(set[0]), await digest(set[1]), `target ${t + 1}: one seed for the whole set`)
    }
    assert.notEqual(await digest(sets[0][0]), await digest(sets[1][0]), 'targets differ')
    assert.notEqual(await digest(sets[1][2]), await digest(sets[2][2]), 'targets differ')

    // Ready/ copies per target, each set in its own folder.
    const ready = await m.db.rows<{ source_id: string; series_folder: string; stage: string; kind: string }>(
      `SELECT source_id, series_folder, stage, kind FROM drive_exports WHERE user_id = $1 AND source_type = 'queue_job' AND source_id LIKE $2 ORDER BY source_id, filename`,
      [ownerId, `${jobId}:%`])
    assert.equal(ready.length, 9)
    const short = photoJobId.replace(/-/g, '').slice(0, 8)
    assert.deepEqual([...new Set(ready.map(r => r.series_folder))], [`pr_${short}_t1_3s`, `pr_${short}_t2_3s`, `pr_${short}_t3_3s`])
    assert.ok(ready.every(r => r.stage === 'ready' && r.kind === 'carousels'))
  })

  it('post: one file per target; status of a job that is not ours or not this type is 404', async () => {
    const { ids } = await archivedSet([await photo(90)], 'post')
    const placed = await order({ driveFileIds: ids, format: 'post', count: 2, characterKey: 'tiana_normal' })
    const jobId = String(placed.body.jobId)
    await runWorker(jobId)
    const s = await status(jobId)
    assert.equal(s.body.sets.length, 2)
    assert.ok(s.body.sets.every(set => Array.isArray(set) && set.length === 1))
    assert.equal((await status(randomUUID())).status, 404)
    const video = await m.db.one<{ id: string }>(`INSERT INTO generation_queue (user_id, job_type, input) VALUES ($1, 'video_repurpose', '{}') RETURNING id`, [ownerId])
    assert.equal((await status(video!.id)).status, 404)
  })

  it('characters: imageRawFolders per format from the archive folder cache (null until the first photo)', async () => {
    await m.db.query(
      `INSERT INTO drive_folders (user_id, character_key, kind, model_key, stage, path, folder_id)
       VALUES ($1, 'tiana_normal', 'posts', 'p', 'raw', 'IGreplicator/tiana_normal/Post/raw', 'fld-post'),
              ($1, 'tiana_normal', 'carousels', 'c', 'raw', 'IGreplicator/tiana_normal/carousel/raw', 'fld-car')`, [ownerId])
    const res = await m.characters.GET(new m.NextRequest('http://localhost/api/content-ops/characters', { headers: auth() }))
    const body = await res.json() as { characters: { key: string; rawFolderId: string | null; imageRawFolders: Record<string, string | null> }[] }
    const tiana = body.characters.find(c => c.key === 'tiana_normal')!
    assert.deepEqual(tiana.imageRawFolders, { post: 'fld-post', story: null, carousel: 'fld-car' })
    assert.equal(tiana.rawFolderId, null)
  })

  it('farmTargetSeed: one seed per target, distinct across targets', () => {
    const seeds = Array.from({ length: 20 }, (_, t) => m.lib.farmTargetSeed(123456, t))
    assert.equal(new Set(seeds).size, 20)
    assert.equal(m.lib.farmTargetSeed(123456, 3), m.lib.farmTargetSeed(123456, 3))
  })
})
