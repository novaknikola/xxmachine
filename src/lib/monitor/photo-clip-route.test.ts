/**
 * /api/extension/clip with the Photo Replicator target, through the real route
 * and the real PAT check (Postgres: TEST_DATABASE_URL — skipped without it).
 * Only the paths that need no network: auth, the switch, the owner rule, and
 * the unchanged Copy Prompts default. Re-host and Sheet are covered by
 * photo-source / photo-sheet / photo-clip tests.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const OWNER_EMAIL = `owner-${randomUUID().slice(0, 8)}@photo-test.local`
const OTHER_EMAIL = `other-${randomUUID().slice(0, 8)}@photo-test.local`

type Route = typeof import('@/app/api/extension/clip/route')
type Db = typeof import('@/lib/db')
let route: Route
let db: Db
let NextRequestCtor: typeof import('next/server').NextRequest
const tokens: Record<'owner' | 'other', string> = { owner: '', other: '' }
const userIds: string[] = []

async function makeUser(email: string): Promise<{ id: string; token: string }> {
  const user = await db.one<{ id: string }>(
    `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, 'Photo test', 'chatter', 'x') RETURNING id`,
    [email],
  )
  const token = `xmpat_${randomBytes(24).toString('base64url')}`
  await db.query(
    `INSERT INTO personal_access_tokens (user_id, token_hash, label) VALUES ($1, $2, 'Browser extension')`,
    [user!.id, createHash('sha256').update(token).digest('hex')],
  )
  userIds.push(user!.id)
  return { id: user!.id, token }
}

function post(body: unknown, token?: string) {
  return route.POST(new NextRequestCtor('http://localhost/api/extension/clip', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }))
}

const photo = {
  target: 'photo-replicator',
  imageUrl: 'https://scontent.cdninstagram.com/v/t51/photo.jpg?oe=1',
  pageUrl: 'https://www.instagram.com/',
  permalink: 'https://www.instagram.com/p/DPhoto123/',
}

describe('POST /api/extension/clip — Photo Replicator target', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.OWNER_EMAIL = OWNER_EMAIL
    delete process.env.PHOTO_REPLICATOR_ENABLED
    db = await import('@/lib/db')
    route = await import('@/app/api/extension/clip/route')
    NextRequestCtor = (await import('next/server')).NextRequest
    tokens.owner = (await makeUser(OWNER_EMAIL)).token
    tokens.other = (await makeUser(OTHER_EMAIL)).token
  })

  after(async () => {
    if (userIds.length) await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds])
    const pool = (globalThis as { __xmDbPool?: { end(): Promise<void> } }).__xmDbPool
    await pool?.end()
  })

  const pins = async () => Number((await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM pinterest_pins p JOIN pinterest_boards b ON b.id = p.board_id WHERE b.user_id = ANY($1::uuid[])`,
    [userIds],
  ))!.n)

  it('no token → 401', async () => {
    assert.equal((await post(photo)).status, 401)
  })

  it('switch off (default) → 403, and nothing is written anywhere', async () => {
    const res = await post(photo, tokens.owner)
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /nije uključen/)
    assert.equal(await pins(), 0, 'the Photo target never falls through to Copy Prompts')
  })

  it('switch on, not the owner → 403, nothing written', async () => {
    process.env.PHOTO_REPLICATOR_ENABLED = 'true'
    try {
      const res = await post(photo, tokens.other)
      assert.equal(res.status, 403)
      assert.match((await res.json()).error, /samo vlasniku/)
      assert.equal(await pins(), 0)
    } finally {
      delete process.env.PHOTO_REPLICATOR_ENABLED
    }
  })

  it('switch on, owner, an off-list host → 400 HOST_NOT_ALLOWED before any fetch', async () => {
    process.env.PHOTO_REPLICATOR_ENABLED = 'true'
    try {
      const res = await post({ ...photo, imageUrl: 'https://example.com/a.jpg' }, tokens.owner)
      assert.equal(res.status, 400)
      assert.equal((await res.json()).code, 'HOST_NOT_ALLOWED')
    } finally {
      delete process.env.PHOTO_REPLICATOR_ENABLED
    }
  })

  it('without a target the Copy Prompts path is unchanged: the clip is saved as a pin', async () => {
    const res = await post({ imageUrl: 'https://i.pinimg.com/originals/aa/bb/photo.jpg', pageUrl: 'https://pinterest.com/pin/1', title: 'T' }, tokens.other)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, saved: 1, alreadySaved: 0, total: 1 })
    assert.equal(await pins(), 1)
  })
})
