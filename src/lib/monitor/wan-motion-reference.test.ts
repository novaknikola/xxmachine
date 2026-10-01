/**
 * The Wan motion reference: the source person's marks are gone, her motion and
 * the rest of the reel are not, and nothing unscrubbed is ever handed on. Plus
 * the request Wan gets built from it. Runs on ffmpeg; no network, no database.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  FIXTURE, SUBJECT, inkIn, inkPixels, readRgbFrames, renderInkFixtures, streamFacts, subjectX, type InkFixtures,
} from './ink-fixture.test-util'
import { buildMotionReference, scrubSubjectAppearance } from './wan-motion-reference'
import { buildWanReferencePayload, WAN_MOTION_REFERENCE_PROMPT } from './wan-reference'
import { wanReferenceInput } from './wan-jobs'

let dir: string
let fx: InkFixtures

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wan-motion-test-'))
  fx = renderInkFixtures(dir)
})
after(() => rmSync(dir, { recursive: true, force: true }))

const luma = (f: Buffer, i: number) => 0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2]

/** Spread of brightness inside the subject, away from her edges — high where line work is. */
function interiorSpread(frame: Buffer, t: number): number {
  const x0 = Math.round(subjectX(t)) + 30
  const values: number[] = []
  for (let y = SUBJECT.y + 50; y < SUBJECT.y + 190; y++) {
    for (let x = x0; x < x0 + 60; x++) values.push(luma(frame, (y * FIXTURE.width + x) * 3))
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
}

/** Horizontal centre of whatever differs from the empty scene in the subject's rows. */
function subjectCentre(frame: Buffer, scene: Buffer): number {
  let sum = 0
  let n = 0
  for (let y = SUBJECT.y + 20; y < SUBJECT.y + SUBJECT.h - 20; y++) {
    for (let x = 0; x < FIXTURE.width; x++) {
      const i = (y * FIXTURE.width + x) * 3
      if (Math.abs(luma(frame, i) - luma(scene, i)) > 25) { sum += x; n++ }
    }
  }
  return n ? sum / n : NaN
}

/** Warm, saturated pixels: the source subject's own skin. Nothing in a scrubbed frame is that colour. */
function skinPixels(frame: Buffer): number {
  let n = 0
  for (let i = 0; i < frame.length; i += 3) if (frame[i] - frame[i + 2] > 40 && frame[i] > 100) n++
  return n
}

/** Mean absolute difference over rows the subject never reaches. */
function backgroundDrift(a: Buffer, b: Buffer): number {
  let d = 0
  let n = 0
  for (const [from, to] of [[0, SUBJECT.y - 40], [SUBJECT.y + SUBJECT.h + 40, FIXTURE.height]]) {
    for (let i = from * FIXTURE.width * 3; i < to * FIXTURE.width * 3; i++) { d += Math.abs(a[i] - b[i]); n++ }
  }
  return d / n
}

describe('scrubbed motion reference', () => {
  it('the source person\'s ink is gone; her motion, the scene, timing and sound are kept', async () => {
    const out = join(dir, 'scrubbed.mp4')
    const { coverage } = await scrubSubjectAppearance(fx.source, fx.matte, out)
    assert.ok(Math.abs(coverage - 0.125) < 0.02, `coverage ${coverage}`) // 120×240 of 360×640

    assert.deepEqual(streamFacts(out), streamFacts(fx.source), 'same frames, rate, length and audio')

    const src = readRgbFrames(fx.source).frames
    const res = readRgbFrames(out).frames
    const scene = readRgbFrames(fx.sceneOnly).frames
    assert.ok(src.every(f => inkPixels(f) > 1000), 'fixture sanity: ink in every source frame')
    assert.equal(res.reduce((n, f) => n + inkPixels(f), 0), 0, 'no ink colour anywhere in the output')
    assert.equal(res.reduce((n, f) => n + skinPixels(f), 0), 0, 'none of her own skin colour either')

    // Line work, not just its colour: the subject's interior goes flat.
    for (const i of [0, 12, 24, 36, 47]) {
      const t = i / FIXTURE.fps
      const before = interiorSpread(src[i], t)
      const after = interiorSpread(res[i], t)
      assert.ok(before > 30, `frame ${i}: fixture line work spread ${before.toFixed(1)}`)
      assert.ok(after < before * 0.25, `frame ${i}: line work survives (spread ${before.toFixed(1)} → ${after.toFixed(1)})`)
    }

    // Motion: she is where she was, every frame, and she does move. Measured
    // the same way on both, so the scene's own bias cancels; the bound is half
    // the fill blur (σ ≈ 10px here), which is all a blur can shift a centre by.
    const before = src.map((f, i) => subjectCentre(f, scene[i]))
    const after = res.map((f, i) => subjectCentre(f, scene[i]))
    const offsets = after.map((x, i) => x - before[i])
    offsets.forEach((d, i) => assert.ok(Math.abs(d) <= 5, `frame ${i}: subject moved ${d.toFixed(1)}px by the scrub`))
    assert.ok(Math.abs(offsets.reduce((a, b) => a + b, 0) / offsets.length) <= 1.5)
    const travel = (xs: number[]) => xs[xs.length - 1] - xs[0]
    assert.ok(travel(before) > 100, 'fixture sanity: the subject crosses the frame')
    assert.ok(Math.abs(travel(after) - travel(before)) <= 5, `travel ${travel(before).toFixed(1)} → ${travel(after).toFixed(1)}`)

    // Scene outside her: only the re-encode, nothing else.
    for (const i of [0, 24, 47]) {
      const drift = backgroundDrift(src[i], res[i])
      assert.ok(drift < 2, `frame ${i}: background drift ${drift.toFixed(2)}`)
    }
  })

  it('a phone clip with uneven frame timing gets each frame\'s own mask, as the check paired them', async () => {
    // Fast subject (≈17px per frame); every other frame stamped 0.3 frame early,
    // as phones do. The remover hands back an even-rate matte, frame for frame.
    const fast = renderInkFixtures(mkdtempSync(join(dir, 'fast-')), 400)
    const uneven = join(dir, 'uneven.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', fast.source,
      '-vf', `setpts='PTS-mod(N,2)*0.3/${FIXTURE.fps}/TB'`, '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-c:v', 'libx264', '-crf', '16', '-c:a', 'copy', uneven])
    const out = join(dir, 'uneven-scrubbed.mp4')
    await scrubSubjectAppearance(uneven, fast.matte, out)
    const frames = readRgbFrames(out).frames
    assert.equal(frames.reduce((n, f) => n + skinPixels(f), 0), 0, 'source skin exposed — a frame was scrubbed with its neighbour\'s mask')
    assert.equal(frames.reduce((n, f) => n + inkPixels(f), 0), 0)
  })

  it('accepts what a correct remover may return: an alpha matte, a smaller one, a relit one', async () => {
    const h264 = ['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']
    const half = join(dir, 'matte-half.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', fx.matte, '-vf', 'scale=180:320', ...h264, half])
    // "Blending that accounts for lighting": brighter, warmer — same place, same frame.
    const relit = join(dir, 'matte-relit.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', fx.matte, '-vf', "geq=r='min(255,r(X,Y)*1.15+30)':g='g(X,Y)':b='b(X,Y)*0.85'", ...h264, relit])
    for (const matte of [fx.alphaMatte, half, relit]) {
      const out = join(dir, 'scrubbed-variant.mp4')
      await scrubSubjectAppearance(fx.source, matte, out)
      assert.equal(inkIn(out), 0, matte)
      assert.equal(streamFacts(out).frames, streamFacts(fx.source).frames, matte)
    }
  })

  /** A remover output that breaks the contract in one specific way. */
  function brokenMatte(name: string, args: string[]): string {
    const out = join(dir, name)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out])
    return out
  }
  const h264 = ['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']

  // Each of these was accepted before, and all but the no-key ones let the
  // source person's skin or ink through. Whatever cannot be verified as her
  // mask, frame for frame and pixel for pixel, never becomes a motion reference.
  const refusals: [string, () => string, RegExp][] = [
    ['nobody matted', () => fx.emptyMatte, /found no person/],
    ['video stops at 1s', () => brokenMatte('short.mp4', ['-i', fx.matte, '-t', '1', ...h264]), /ends before the reel/],
    ['one frame short', () => brokenMatte('short1.mp4', [
      '-i', fx.matte, '-vf', `trim=end_frame=${FIXTURE.fps * FIXTURE.seconds - 1}`, ...h264,
    ]), /ends before the reel/],
    ['1s video in a 2s container (audio pads it)', () => brokenMatte('padded.mp4', [
      '-t', '1', '-i', fx.matte, '-f', 'lavfi', '-t', '2', '-i', 'sine=d=2', '-map', '0:v', '-map', '1:a', ...h264, '-c:a', 'aac',
    ]), /ends before the reel/],
    ['same length, 0.2s late', () => brokenMatte('late.mp4', [
      '-i', fx.matte, '-vf', `tpad=start_duration=0.2:color=0x00FF00,trim=duration=${FIXTURE.seconds}`, ...h264,
    ]), /does not line up/],
    ['same length, one frame late', () => brokenMatte('late1.mp4', [
      '-i', fx.matte, '-vf', `tpad=start=1:start_mode=add:color=0x00FF00,trim=end_frame=${FIXTURE.fps * FIXTURE.seconds}`, ...h264,
    ]), /does not line up/],
    ['shifted 4px sideways', () => brokenMatte('shift4.mp4', [
      '-i', fx.matte, '-vf', 'crop=iw-4:ih:0:0,pad=iw+4:ih:4:0:color=0x00FF00', ...h264,
    ]), /does not line up/],
    ['letterboxed 40px top and bottom', () => brokenMatte('boxed.mp4', [
      '-i', fx.matte, '-vf', `pad=${FIXTURE.width}:${FIXTURE.height + 80}:0:40:color=0x00FF00`, ...h264,
    ]), /does not line up/],
    ['background not replaced (the reel itself)', () => fx.source, /no key-green background/],
    ['transparent VP9 (alpha lost on decode)', () => brokenMatte('alpha.webm', [
      '-i', fx.alphaMatte, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '2M',
    ]), /no key-green background/],
    ['a mask video, white on black', () => brokenMatte('mask.mp4', ['-i', fx.alphaMatte, '-vf', 'alphaextract', ...h264]), /no key-green background/],
  ]
  for (const [name, matte, reason] of refusals) {
    it(`refuses a remover output it cannot verify: ${name}`, async () => {
      await assert.rejects(scrubSubjectAppearance(fx.source, matte(), join(dir, 'never.mp4')), reason)
    })
  }
})

describe('buildMotionReference', () => {
  const store = new Map<string, Buffer>()
  const posts: { url: string; body: Record<string, unknown> }[] = []
  let matteFile = ''
  let server: http.Server
  let base = ''
  const realFetch = globalThis.fetch

  before(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url.startsWith('/storage/v1/object/generations/')) {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          store.set(url.replace('/storage/v1/object/generations/', ''), Buffer.concat(chunks))
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        })
        return
      }
      const stored = store.get(url.replace('/storage/v1/object/public/generations/', ''))
      if (stored) return void res.writeHead(200).end(stored)
      if (url === '/cdn/source.mp4') return void res.writeHead(200).end(readFileSync(fx.source))
      if (url === '/ws/matte.mp4') return void res.writeHead(200).end(readFileSync(matteFile))
      res.writeHead(404).end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    Object.assign(process.env, { SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'test' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.wavespeed.ai')) {
        if (init?.method === 'POST') {
          posts.push({ url, body: JSON.parse(String(init.body)) })
          return Response.json({ code: 200, data: { id: 'req-matte' } })
        }
        return Response.json({ code: 200, data: { status: 'completed', outputs: [`${base}/ws/matte.mp4`] } })
      }
      return realFetch(input, init)
    }) as typeof fetch
  })
  after(() => {
    globalThis.fetch = realFetch
    server?.close()
  })

  async function download(url: string): Promise<string> {
    const file = join(mkdtempSync(join(dir, 'dl-')), 'media')
    writeFileSync(file, Buffer.from(await (await realFetch(url)).arrayBuffer()))
    return file
  }

  it('mattes the reel on key green and stores the scrubbed copy under a fresh name', async () => {
    matteFile = fx.matte
    const sourceVideoUrl = `${base}/cdn/source.mp4`
    const first = await buildMotionReference({ jobId: 'job-1', sourceVideoUrl, apiKey: 'k' })
    const second = await buildMotionReference({ jobId: 'job-1', sourceVideoUrl, apiKey: 'k' })

    assert.match(first, /\/monitor\/job-1\/wan-motion-[0-9a-f]{8}\.mp4$/)
    assert.notEqual(first, second)
    assert.equal(posts.length, 2)
    assert.ok(posts[0].url.endsWith('/wavespeed-ai/video-background-remover'))
    assert.equal(posts[0].body.video, sourceVideoUrl)
    assert.equal(posts[0].body.background_image, `${base}/storage/v1/object/public/generations/monitor/job-1/matte-key.png`)

    const key = readRgbFrames(await download(String(posts[0].body.background_image)))
    assert.deepEqual([key.width, key.height], [FIXTURE.width, FIXTURE.height])
    const px = key.frames[0]
    assert.deepEqual([px[0], px[1], px[2]], [0, 255, 0])

    const motion = await download(first)
    assert.equal(inkIn(motion), 0)
    assert.deepEqual(streamFacts(motion), streamFacts(fx.source))
  })

  it('stores nothing when the matte found nobody', async () => {
    matteFile = fx.emptyMatte
    const before = [...store.keys()].filter(k => k.startsWith('monitor/job-2/wan-motion-'))
    await assert.rejects(
      buildMotionReference({ jobId: 'job-2', sourceVideoUrl: `${base}/cdn/source.mp4`, apiKey: 'k' }),
      /found no person/,
    )
    assert.deepEqual([...store.keys()].filter(k => k.startsWith('monitor/job-2/wan-motion-')), before)
  })
})

describe('Wan 3.0 request', () => {
  const job = {
    reference_image_url: 'https://s/character.jpg',
    still_image_url: 'https://s/monitor/j/wan-still-1a2b3c4d.jpg',
    motion_video_url: 'https://s/monitor/j/wan-motion-1a2b3c4d.mp4',
    video_url: 'https://s/monitor/j/source.mp4',
    aspect_ratio: '9:16',
    source_duration: 7.4,
  }

  it('sends Image 1 the character, Image 2 the approved still, Video 1 the scrubbed reel — nothing else', () => {
    const body = buildWanReferencePayload(wanReferenceInput(job))
    assert.deepEqual(body.reference_images, [job.reference_image_url, job.still_image_url])
    assert.deepEqual(body.reference_videos, [job.motion_video_url])
    assert.ok(!JSON.stringify(body).includes(job.video_url), 'raw reel nowhere in the request')
    assert.equal(body.duration, 7)
    assert.equal(body.aspect_ratio, '9:16')
    assert.equal(body.enable_prompt_expansion, false)
    assert.equal(body.prompt, WAN_MOTION_REFERENCE_PROMPT)
    assert.ok(!('negative_prompt' in body))
  })

  it('names every input by its role and keeps the text-removal instruction', () => {
    for (const role of ['Image 1', 'Image 2', 'Video 1']) assert.ok(WAN_MOTION_REFERENCE_PROMPT.includes(role), role)
    assert.match(WAN_MOTION_REFERENCE_PROMPT, /motion reference only/)
    assert.match(WAN_MOTION_REFERENCE_PROMPT, /never her look/)
    assert.match(WAN_MOTION_REFERENCE_PROMPT, /Remove text on screen, remove captions\.$/)
  })

  it('refuses a job without a scrubbed reel or an approved still, instead of sending the raw reel', () => {
    assert.throws(() => wanReferenceInput({ ...job, motion_video_url: null }), /not sending the raw reel/)
    assert.throws(() => wanReferenceInput({ ...job, motion_video_url: job.video_url }), /not sending the raw reel/)
    assert.throws(() => wanReferenceInput({ ...job, still_image_url: null }), /no approved still/)
  })
})
