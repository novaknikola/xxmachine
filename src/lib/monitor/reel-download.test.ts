/**
 * Media URL → checked copy in our storage, against a local "CDN" and a fake
 * Supabase storage. Real ffmpeg files; no network.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { acquireReelVideo, ReelDownloadError, ReelStorageError } from './reel-download'

let dir: string
let server: http.Server
let base = ''
const stored = new Map<string, Buffer>()
let uploads = 0

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reel-download-test-'))
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
  ff(['-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'reel.mp4')])
  ff(['-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'silent.mp4')])
  const files: Record<string, Buffer> = {
    '/cdn/reel.mp4': readFileSync(join(dir, 'reel.mp4')),
    '/cdn/silent.mp4': readFileSync(join(dir, 'silent.mp4')),
    // A login page served with 200 — what an expired or gated link can look like.
    '/cdn/login.html': Buffer.from(`<!doctype html><html><body>${'Log in to Instagram. '.repeat(200)}</body></html>`),
  }
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/storage/v1/object/generations/')) {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const path = url.replace('/storage/v1/object/generations/', '')
        if (path.includes('fail-store')) return void res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"bucket quota exceeded"}')
        uploads++
        stored.set(path, Buffer.concat(chunks))
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
      return
    }
    const own = stored.get(url.replace('/storage/v1/object/public/generations/', ''))
    if (own) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(own)
    const f = files[url]
    if (f) return void res.writeHead(200, { 'content-type': url.endsWith('.html') ? 'text/html' : 'video/mp4' }).end(f)
    res.writeHead(404).end('not found')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  Object.assign(process.env, { SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'test' })
})
after(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireReelVideo', () => {
  it('9, 11. downloads, checks and stores — and hands back our URL, not the CDN one', async () => {
    const cdnUrl = `${base}/cdn/reel.mp4`
    const got = await acquireReelVideo({ mediaUrl: cdnUrl, storagePath: 'monitor/job-1/source.mp4' })
    assert.equal(got.url, `${base}/storage/v1/object/public/generations/monitor/job-1/source.mp4`)
    assert.notEqual(got.url, cdnUrl)
    assert.equal(got.copied, true)
    assert.equal(got.hasAudio, true)
    assert.deepEqual([got.width, got.height], [180, 320])
    assert.ok(Math.abs(got.durationSec - 2) < 0.2, `duration ${got.durationSec}`)
    assert.deepEqual(stored.get('monitor/job-1/source.mp4'), readFileSync(join(dir, 'reel.mp4')))
  })

  it('10. a link that does not answer is DOWNLOAD_FAILED', async () => {
    await assert.rejects(acquireReelVideo({ mediaUrl: `${base}/cdn/expired.mp4`, storagePath: 'monitor/job-2/source.mp4' }),
      (e: unknown) => e instanceof ReelDownloadError && e.code === 'DOWNLOAD_FAILED' && /404/.test(e.message))
    assert.equal(stored.has('monitor/job-2/source.mp4'), false)
  })

  it('10. a page instead of a video is DOWNLOAD_FAILED, and nothing is stored', async () => {
    await assert.rejects(acquireReelVideo({ mediaUrl: `${base}/cdn/login.html`, storagePath: 'monitor/job-3/source.mp4' }),
      (e: unknown) => e instanceof ReelDownloadError && /not a readable media file|no video stream/.test(e.message))
    assert.equal(stored.has('monitor/job-3/source.mp4'), false)
  })

  it('a checked video our storage refuses is STORAGE_FAILED, not a download failure', async () => {
    await assert.rejects(acquireReelVideo({ mediaUrl: `${base}/cdn/reel.mp4`, storagePath: 'monitor/fail-store/source.mp4' }),
      (e: unknown) => e instanceof ReelStorageError && e.code === 'STORAGE_FAILED' && /bucket quota exceeded/.test(e.message))
  })

  it('7. no audio track is reported, not refused — the caller decides', async () => {
    const got = await acquireReelVideo({ mediaUrl: `${base}/cdn/silent.mp4`, storagePath: 'monitor/job-4/source.mp4' })
    assert.equal(got.hasAudio, false)
    assert.equal(got.copied, true)
  })

  it('a URL that is already ours is checked, not copied again', async () => {
    const before = uploads
    const own = `${base}/storage/v1/object/public/generations/monitor/job-1/source.mp4`
    const got = await acquireReelVideo({ mediaUrl: own, storagePath: 'monitor/job-5/source.mp4' })
    assert.equal(got.url, own)
    assert.equal(got.copied, false)
    assert.equal(got.hasAudio, true)
    assert.equal(uploads, before)
  })
})
