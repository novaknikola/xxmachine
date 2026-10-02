/**
 * The Clipper's "→ Photo Replicator" target, against fake re-host and Sheet:
 * who may use it, what each failure answers, what lands in the row.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clipToPhotoReplicator, photoSourceLink, type PhotoClipDeps } from './photo-clip'
import { PhotoSourceError, type PhotoSource } from './photo-source'
import type { PhotoRowInput } from './photo-sheet'

const OWNER = { id: '0b6c3f0e-4c1e-4d7a-9a51-6b1f2f0b9e11', email: 'owner@example.com' }
const STORED: PhotoSource = {
  url: 'https://store.example/public/photo-replicator/u/abc.jpg', sha256: 'abc', width: 1080, height: 1350,
  bytes: 1234, format: 'jpeg', reused: false,
}

function fakes(over: Partial<PhotoClipDeps> = {}) {
  const rows: { input: PhotoRowInput; names: string[] }[] = []
  const rehosts: string[] = []
  const deps: PhotoClipDeps = {
    enabled: () => true,
    isOwner: email => email === OWNER.email,
    rehost: async ({ imageUrl }) => { rehosts.push(imageUrl); return STORED },
    characterNames: async () => ['Diana Goth', 'Tiana Normal'],
    addRow: async (input, names) => { rows.push({ input, names }); return { rowNumber: 5, appended: true } },
    now: () => new Date('2026-10-02T14:33:00Z'),
    ...over,
  }
  return { deps, rows, rehosts }
}

const body = { imageUrl: 'https://scontent.cdninstagram.com/x.jpg?oe=1', pageUrl: 'https://www.instagram.com/', permalink: 'https://www.instagram.com/p/DPhoto123/?img_index=2' }

describe('clipToPhotoReplicator', () => {
  it('re-hosts, then adds the row with our URL and the post permalink', async () => {
    const f = fakes()
    const got = await clipToPhotoReplicator(OWNER, body, f.deps)
    assert.equal(got.status, 200)
    assert.deepEqual(got.body, {
      ok: true, target: 'photo-replicator', rowNumber: 5, alreadyInSheet: false,
      imageUrl: STORED.url, width: 1080, height: 1350, reusedStorage: false,
    })
    assert.deepEqual(f.rehosts, [body.imageUrl])
    assert.deepEqual(f.rows, [{
      input: { imageUrl: STORED.url, source: 'https://www.instagram.com/p/DPhoto123/?img_index=2', addedAt: new Date('2026-10-02T14:33:00Z') },
      names: ['Diana Goth', 'Tiana Normal'],
    }])
  })

  it('a photo that already has a row says so', async () => {
    const f = fakes({ addRow: async () => ({ rowNumber: 3, appended: false }) })
    const got = await clipToPhotoReplicator(OWNER, body, f.deps)
    assert.equal(got.status, 200)
    assert.equal(got.body.alreadyInSheet, true)
    assert.equal(got.body.rowNumber, 3)
  })

  it('off unless PHOTO_REPLICATOR_ENABLED — and then nothing is fetched or written', async () => {
    const f = fakes({ enabled: () => false })
    const got = await clipToPhotoReplicator(OWNER, body, f.deps)
    assert.equal(got.status, 403)
    assert.deepEqual([f.rehosts.length, f.rows.length], [0, 0])
  })

  it('only the owner — the rows land in the owner\'s spreadsheet', async () => {
    const f = fakes()
    const got = await clipToPhotoReplicator({ id: OWNER.id, email: 'someone@else.com' }, body, f.deps)
    assert.equal(got.status, 403)
    assert.deepEqual([f.rehosts.length, f.rows.length], [0, 0])
  })

  it('needs an image URL', async () => {
    const f = fakes()
    assert.equal((await clipToPhotoReplicator(OWNER, { pageUrl: 'x' }, f.deps)).status, 400)
    assert.equal((await clipToPhotoReplicator(OWNER, { imageUrl: 42 }, f.deps)).status, 400)
  })

  it('each re-host failure has its own status and code, and adds no row', async () => {
    const cases: [PhotoSourceError['code'], number][] = [
      ['INVALID_URL', 400], ['HOST_NOT_ALLOWED', 400], ['TOO_LARGE', 413], ['NOT_AN_IMAGE', 422],
      ['TOO_SMALL', 422], ['FETCH_FAILED', 502], ['STORAGE_FAILED', 502],
    ]
    for (const [code, status] of cases) {
      const f = fakes({ rehost: async () => { throw new PhotoSourceError(code, `msg ${code}`) } })
      const got = await clipToPhotoReplicator(OWNER, body, f.deps)
      assert.deepEqual([got.status, got.body.code, got.body.error], [status, code, `msg ${code}`])
      assert.equal(f.rows.length, 0)
    }
  })

  it('a Sheet failure after a good re-host is 502 SHEET_FAILED (clipping again retries the row)', async () => {
    const f = fakes({ addRow: async () => { throw new Error('Failed to append: 503') } })
    const got = await clipToPhotoReplicator(OWNER, body, f.deps)
    assert.deepEqual([got.status, got.body.code], [502, 'SHEET_FAILED'])
  })
})

describe('photoSourceLink', () => {
  it('prefers the post permalink, canonical /p/ form, no query', () => {
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/', 'https://www.instagram.com/'), 'https://www.instagram.com/p/DPhoto123/')
    assert.equal(photoSourceLink('https://www.instagram.com/reel/DReel4567/', ''), 'https://www.instagram.com/p/DReel4567/')
    assert.equal(photoSourceLink('https://www.instagram.com/someuser/p/DPhoto123/', ''), 'https://www.instagram.com/p/DPhoto123/')
  })

  it('keeps the carousel slide: ?img_index=1 and ?img_index=2 are preserved', () => {
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/?img_index=1', 'https://www.instagram.com/'), 'https://www.instagram.com/p/DPhoto123/?img_index=1')
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/?img_index=2', 'https://www.instagram.com/'), 'https://www.instagram.com/p/DPhoto123/?img_index=2')
    assert.equal(photoSourceLink('https://www.instagram.com/someuser/p/DPhoto123/?img_index=2', ''), 'https://www.instagram.com/p/DPhoto123/?img_index=2')
  })

  it('without img_index nothing changes, and other query parameters are still dropped', () => {
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/?utm_source=ig_web_copy_link', ''), 'https://www.instagram.com/p/DPhoto123/')
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/?img_index=3&utm_source=ig_web&igsh=abc', ''), 'https://www.instagram.com/p/DPhoto123/?img_index=3')
  })

  it('a value that is not a slide number is ignored', () => {
    for (const bad of ['0', '21', '-1', '1.5', 'abc', '', '2x', '999']) {
      assert.equal(photoSourceLink(`https://www.instagram.com/p/DPhoto123/?img_index=${bad}`, ''), 'https://www.instagram.com/p/DPhoto123/', `img_index=${bad}`)
    }
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/?img_index=02', ''), 'https://www.instagram.com/p/DPhoto123/?img_index=2')
  })

  it('the slide may come from the page URL — only when the page is that same post', () => {
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/', 'https://www.instagram.com/p/DPhoto123/?img_index=2'), 'https://www.instagram.com/p/DPhoto123/?img_index=2')
    assert.equal(photoSourceLink('https://www.instagram.com/p/DPhoto123/', 'https://www.instagram.com/p/DOther9876/?img_index=2'), 'https://www.instagram.com/p/DPhoto123/')
    assert.equal(photoSourceLink(undefined, 'https://www.instagram.com/p/DPhoto123/?img_index=4'), 'https://www.instagram.com/p/DPhoto123/?img_index=4')
  })

  it('falls back to the page being on the post, then to the page without its query', () => {
    assert.equal(photoSourceLink(undefined, 'https://www.instagram.com/p/DPhoto123/?hl=en'), 'https://www.instagram.com/p/DPhoto123/')
    assert.equal(photoSourceLink('', 'https://www.instagram.com/explore/?next=1#x'), 'https://www.instagram.com/explore/')
    assert.equal(photoSourceLink('', 'https://www.instagram.com/explore/?img_index=2'), 'https://www.instagram.com/explore/', 'not a post: query dropped as before')
    assert.equal(photoSourceLink(null, 'javascript:alert(1)'), '')
    assert.equal(photoSourceLink(null, 'not a url'), '')
  })
})
