/**
 * Photo Replicator 2D — the optional sharper source, against fake providers.
 * The rule under test: a candidate is used only when it is the same picture
 * and bigger; every other outcome keeps the Phase 1 photo and says why.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import {
  UPGRADE_TIMEOUT_MS,
  apifyPhotoUrls,
  intropixPhotoUrls,
  postRef,
  upgradePhotoSource,
  type UpgradeDeps,
} from './photo-source-upgrade'
import type { PhotoSource } from './photo-source'

/** A picture with structure (so a resize still matches it) — noise blocks at 64×80. */
async function picture(): Promise<Buffer> {
  return sharp(randomBytes(64 * 80 * 3), { raw: { width: 64, height: 80, channels: 3 } }).png().toBuffer()
}
const at = (pic: Buffer, w: number, h: number) => sharp(pic).resize(w, h, { fit: 'fill', kernel: 'nearest' }).jpeg({ quality: 90 }).toBuffer()

function fakes(files: Record<string, Buffer>, over: Partial<UpgradeDeps> = {}) {
  const calls: string[] = []
  const deps: UpgradeDeps = {
    download: async url => {
      const f = files[url]
      if (!f) throw new Error(`404 ${url}`)
      return f
    },
    apify: async () => { calls.push('apify'); return null },
    intropix: async () => { calls.push('intropix'); return null },
    rehost: async ({ imageUrl }): Promise<PhotoSource> => {
      calls.push(`rehost ${imageUrl}`)
      const meta = await sharp(files[imageUrl]).metadata()
      return { url: `https://store/${imageUrl.split('/').pop()}`, sha256: 'x', width: meta.width!, height: meta.height!, bytes: 1, format: 'jpeg', reused: false }
    },
    ...over,
  }
  return { deps, calls }
}

const job = (sourceLink: string | null) => ({ user_id: 'u', source_url: 'https://store/clip.jpg', source_link: sourceLink })

describe('upgradePhotoSource', () => {
  it('a photo already ≥1000 px is kept without asking any provider', async () => {
    const f = fakes({ 'https://store/clip.jpg': await at(await picture(), 1080, 1350) })
    const out = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), f.deps)
    assert.equal(out.url, null)
    assert.match(out.note, /^kept: Phase 1 photo is 1080x1350/)
    assert.deepEqual(f.calls, [])
  })

  it('a small carousel slide is replaced by the same slide at full size (Apify), matched by picture not by index', async () => {
    const [s1, s2] = [await picture(), await picture()]
    const files = {
      'https://store/clip.jpg': await at(s2, 618, 772),
      'https://cdn/1.jpg': await at(s1, 1080, 1350),
      'https://cdn/2.jpg': await at(s2, 1080, 1350),
    }
    const f = fakes(files, {
      apify: async () => ({ type: 'Sidecar', images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }),
    })
    // img_index says slide 1, but the clipped picture is slide 2: the match wins.
    const out = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/?img_index=1'), f.deps)
    assert.equal(out.url, 'https://store/2.jpg')
    assert.match(out.note, /^upgraded 618x772 → 1080x1350 via apify \(slide 2/)
    assert.deepEqual(f.calls.filter(c => c.startsWith('rehost')), ['rehost https://cdn/2.jpg'])
  })

  it('a centre-cropped grid tile still matches its full post photo', async () => {
    const full = await at(await picture(), 1080, 1350)
    const meta = await sharp(full).metadata()
    const cropW = Math.round(meta.height! * (360 / 640))
    const tile = await sharp(full).extract({ left: Math.floor((meta.width! - cropW) / 2), top: 0, width: cropW, height: meta.height! }).resize(360, 640).jpeg().toBuffer()
    const f = fakes({ 'https://store/clip.jpg': tile, 'https://cdn/full.jpg': full }, {
      apify: async () => ({ type: 'Image', displayUrl: 'https://cdn/full.jpg' }),
    })
    const out = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), f.deps)
    assert.equal(out.url, 'https://store/full.jpg')
  })

  it('a different picture is never used', async () => {
    const f = fakes({ 'https://store/clip.jpg': await at(await picture(), 618, 772), 'https://cdn/other.jpg': await at(await picture(), 1080, 1350) }, {
      apify: async () => ({ type: 'Image', displayUrl: 'https://cdn/other.jpg' }),
      intropix: async () => ({ media: [{ media_type: 'image', media_url: 'https://cdn/other.jpg' }] }),
    })
    const out = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), f.deps)
    assert.equal(out.url, null)
    assert.match(out.note, /apify: no slide matches.*intropix: no slide matches/)
  })

  it('Apify failing falls back to Intropix; a spent Apify account skips Intropix (same account)', async () => {
    const pic = await picture()
    const files = { 'https://store/clip.jpg': await at(pic, 480, 600), 'https://cdn/i.jpg': await at(pic, 1440, 1800) }
    const down = fakes(files, {
      apify: async () => { throw new Error('Apify run failed: FAILED') },
      intropix: async () => ({ media: [{ media_type: 'image', media_url: 'https://cdn/i.jpg' }] }),
    })
    const out = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), down.deps)
    assert.match(out.note, /via intropix/)

    const spent = fakes(files, {
      apify: async () => { throw new Error('Monthly usage hard limit exceeded') },
      intropix: async () => { throw new Error('must not be called') },
    })
    const kept = await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), spent.deps)
    assert.equal(kept.url, null)
    assert.match(kept.note, /Monthly usage hard limit/)
    assert.doesNotMatch(kept.note, /must not be called/)
  })

  it('same photo but not bigger → kept; no post link → kept; video slides are skipped', async () => {
    const pic = await picture()
    const same = fakes({ 'https://store/clip.jpg': await at(pic, 640, 800), 'https://cdn/s.jpg': await at(pic, 640, 800) }, {
      apify: async () => ({ type: 'Image', displayUrl: 'https://cdn/s.jpg' }),
    })
    assert.match((await upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), same.deps)).note, /only at 640x800/)
    const noLink = fakes({ 'https://store/clip.jpg': await at(pic, 640, 800) })
    assert.match((await upgradePhotoSource(job('https://www.instagram.com/explore/'), noLink.deps)).note, /no post link/)
    assert.deepEqual(apifyPhotoUrls({ type: 'Sidecar', childPosts: [{ type: 'Video', displayUrl: 'v' }, { type: 'Image', displayUrl: 'p' }] } as never), ['', 'p'])
    assert.deepEqual(apifyPhotoUrls({ type: 'Video', displayUrl: 'v' }), [])
    assert.deepEqual(intropixPhotoUrls({ media: [{ media_type: 'video', media_url: 'v' }, { media_type: 'image', media_url: 'p' }] }), ['', 'p'])
  })

  it('never blocks: a provider that hangs is abandoned after the timeout and the photo is kept', { timeout: UPGRADE_TIMEOUT_MS + 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fakes({ 'https://store/clip.jpg': await at(await picture(), 480, 600) }, {
      apify: () => new Promise(() => {}),
    })
    const pending = upgradePhotoSource(job('https://www.instagram.com/p/DPost1234/'), f.deps)
    await new Promise(r => setImmediate(r))
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    t.mock.timers.tick(UPGRADE_TIMEOUT_MS)
    const out = await pending
    assert.equal(out.url, null)
    assert.match(out.note, /gave up after 90s/)
  })

  it('postRef reads the shortcode and the slide from Izvor', () => {
    assert.deepEqual(postRef('https://www.instagram.com/p/DY55tvLlulo/?img_index=2'), { permalink: 'https://www.instagram.com/p/DY55tvLlulo/', slide: 2 })
    assert.deepEqual(postRef('https://www.instagram.com/p/DY55tvLlulo/'), { permalink: 'https://www.instagram.com/p/DY55tvLlulo/', slide: null })
    assert.equal(postRef(''), null)
    assert.equal(postRef('https://www.instagram.com/explore/'), null)
  })
})
