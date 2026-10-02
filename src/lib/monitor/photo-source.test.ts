/**
 * Photo Replicator re-host: what is fetched, what is refused, where it is stored.
 * Fake fetch and fake storage; real image bytes made with sharp. No network.
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  MAX_PHOTO_SOURCE_BYTES,
  PhotoSourceError,
  isAllowedPhotoHost,
  rehostPhotoSource,
  type PhotoSourceDeps,
} from './photo-source'

const USER = '0b6c3f0e-4c1e-4d7a-9a51-6b1f2f0b9e11'
const IG = 'https://scontent-lax3-1.cdninstagram.com/v/t51.82787-15/photo_n.jpg?stp=dst-jpg_e35_p1080x1080&oh=abc&oe=6A000000'

const img: Record<string, Buffer> = {}
before(async () => {
  const make = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 90 } } })
  img.jpeg = await make(1080, 1350).jpeg().toBuffer()
  img.png = await make(800, 800).png().toBuffer()
  img.webp = await make(640, 800).webp().toBuffer()
  img.tiny = await make(200, 200).jpeg().toBuffer()
  img.gif = await make(400, 400).gif().toBuffer()
})

type Reply = () => Response
function harness(routes: Record<string, Reply>, opts: { exists?: boolean; uploadFails?: boolean } = {}) {
  const fetched: { url: string; redirect?: string }[] = []
  const uploads: { path: string; type: string; bytes: number }[] = []
  const deps: PhotoSourceDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      fetched.push({ url, redirect: init?.redirect })
      const reply = routes[url]
      return reply ? reply() : new Response('not found', { status: 404 })
    }) as typeof fetch,
    exists: async () => !!opts.exists,
    upload: async (buffer, path, type) => {
      if (opts.uploadFails) throw new Error('Storage upload failed: bucket quota exceeded')
      uploads.push({ path, type, bytes: buffer.byteLength })
      return `https://store.example/public/${path}`
    },
    publicUrl: path => `https://store.example/public/${path}`,
  }
  return { deps, fetched, uploads }
}
const image = (buf: Buffer, type = 'image/jpeg', extra: Record<string, string> = {}) =>
  () => new Response(new Uint8Array(buf), { status: 200, headers: { 'content-type': type, 'content-length': String(buf.byteLength), ...extra } })
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })
const fails = async (p: Promise<unknown>, code: PhotoSourceError['code']) =>
  assert.rejects(p, (e: unknown) => e instanceof PhotoSourceError && e.code === code)

describe('rehostPhotoSource', () => {
  it('stores the photo under its SHA-256 and reports its size', async () => {
    const h = harness({ [IG]: image(img.jpeg) })
    const got = await rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps)
    const sha = createHash('sha256').update(img.jpeg).digest('hex')
    assert.equal(got.sha256, sha)
    assert.equal(got.url, `https://store.example/public/photo-replicator/${USER}/${sha}.jpg`)
    assert.deepEqual([got.width, got.height, got.format, got.bytes, got.reused], [1080, 1350, 'jpeg', img.jpeg.byteLength, false])
    assert.deepEqual(h.uploads, [{ path: `photo-replicator/${USER}/${sha}.jpg`, type: 'image/jpeg', bytes: img.jpeg.byteLength }])
    assert.equal(h.fetched[0].redirect, 'manual', 'redirects are followed by hand, never automatically')
  })

  it('the same photo again is not uploaded again (storage dedupe), same URL', async () => {
    const h = harness({ [IG]: image(img.jpeg) }, { exists: true })
    const got = await rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps)
    assert.equal(got.reused, true)
    assert.equal(h.uploads.length, 0)
    assert.match(got.url, /\/photo-replicator\/.+\/[0-9a-f]{64}\.jpg$/)
  })

  it('PNG and WebP keep their own type and extension', async () => {
    const png = 'https://scontent.cdninstagram.com/a.png'
    const webp = 'https://scontent-ams2-1.xx.fbcdn.net/b.webp'
    const h = harness({ [png]: image(img.png, 'image/png'), [webp]: image(img.webp, 'image/webp') })
    const a = await rehostPhotoSource({ userId: USER, imageUrl: png }, h.deps)
    const b = await rehostPhotoSource({ userId: USER, imageUrl: webp }, h.deps)
    assert.deepEqual([a.format, a.url.slice(-4), h.uploads[0].type], ['png', '.png', 'image/png'])
    assert.deepEqual([b.format, b.url.slice(-5), h.uploads[1].type], ['webp', '.webp', 'image/webp'])
  })

  it('https only, and only Instagram/Facebook CDN hosts — nothing else is even fetched', async () => {
    const h = harness({})
    await fails(rehostPhotoSource({ userId: USER, imageUrl: 'http://scontent.cdninstagram.com/a.jpg' }, h.deps), 'INVALID_URL')
    await fails(rehostPhotoSource({ userId: USER, imageUrl: 'not a url' }, h.deps), 'INVALID_URL')
    for (const bad of [
      'https://example.com/a.jpg',
      'https://evilcdninstagram.com/a.jpg',
      'https://cdninstagram.com.evil.net/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://user:pw@scontent.cdninstagram.com/a.jpg',
      'https://scontent.cdninstagram.com:8443/a.jpg',
    ]) {
      await fails(rehostPhotoSource({ userId: USER, imageUrl: bad }, h.deps), 'HOST_NOT_ALLOWED')
    }
    assert.equal(h.fetched.length, 0)
    assert.equal(isAllowedPhotoHost('instagram.fbeg4-1.fna.fbcdn.net'), true)
    assert.equal(isAllowedPhotoHost('cdninstagram.com'), true)
  })

  it('a redirect is followed only to an allowed host, over https, at most 3 times', async () => {
    const fb = 'https://scontent-ams2-1.xx.fbcdn.net/final.jpg'
    let h = harness({ [IG]: redirect(fb), [fb]: image(img.jpeg) })
    assert.equal((await rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps)).width, 1080)

    h = harness({ [IG]: redirect('https://evil.example/steal.jpg') })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'HOST_NOT_ALLOWED')
    assert.deepEqual(h.fetched.map(f => f.url), [IG], 'the off-list target is never requested')

    h = harness({ [IG]: redirect('http://scontent.cdninstagram.com/plain.jpg') })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'INVALID_URL')

    const hop = (n: number) => `https://scontent.cdninstagram.com/hop${n}.jpg`
    h = harness({ [IG]: redirect(hop(1)), [hop(1)]: redirect(hop(2)), [hop(2)]: redirect(hop(3)), [hop(3)]: redirect(hop(4)) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'FETCH_FAILED')
  })

  it('an expired or refused link is FETCH_FAILED', async () => {
    const h = harness({ [IG]: () => new Response('URL signature expired', { status: 403 }) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'FETCH_FAILED')
  })

  it('size limit: refused from the header, and while streaming when no header says so', async () => {
    let h = harness({ [IG]: () => new Response('x', { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_PHOTO_SOURCE_BYTES + 1) } }) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'TOO_LARGE')

    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const endless = () => new Response(new ReadableStream({
      pull(controller) {
        sent += chunk.byteLength
        controller.enqueue(chunk)
        if (sent > MAX_PHOTO_SOURCE_BYTES * 2) controller.close()
      },
    }), { headers: { 'content-type': 'image/jpeg' } })
    h = harness({ [IG]: endless })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'TOO_LARGE')
    assert.ok(sent <= MAX_PHOTO_SOURCE_BYTES + 2 * chunk.byteLength, `stopped reading early (read ${sent} bytes)`)
  })

  it('MIME and decoding: a page, a GIF, or bytes that only claim to be a JPEG are refused', async () => {
    let h = harness({ [IG]: () => new Response('<html>Log in</html>', { headers: { 'content-type': 'text/html' } }) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'NOT_AN_IMAGE')
    h = harness({ [IG]: image(img.gif, 'image/gif') })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'NOT_AN_IMAGE')
    h = harness({ [IG]: image(img.gif, 'image/jpeg') })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'NOT_AN_IMAGE')
    const corrupt = Buffer.concat([img.jpeg.subarray(0, 600), Buffer.alloc(4000, 7)])
    h = harness({ [IG]: image(corrupt) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'NOT_AN_IMAGE')
    assert.equal(h.uploads.length, 0, 'nothing that fails a check is stored')
  })

  it('too small to generate from is TOO_SMALL', async () => {
    const h = harness({ [IG]: image(img.tiny) })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'TOO_SMALL')
    assert.equal(h.uploads.length, 0)
  })

  it('storage refusing the upload is STORAGE_FAILED', async () => {
    const h = harness({ [IG]: image(img.jpeg) }, { uploadFails: true })
    await fails(rehostPhotoSource({ userId: USER, imageUrl: IG }, h.deps), 'STORAGE_FAILED')
  })

  it('refuses a user id that is not a UUID (it becomes part of the storage path)', async () => {
    const h = harness({ [IG]: image(img.jpeg) })
    await assert.rejects(rehostPhotoSource({ userId: '../other', imageUrl: IG }, h.deps), /bad user id/)
    assert.equal(h.fetched.length, 0)
  })
})
