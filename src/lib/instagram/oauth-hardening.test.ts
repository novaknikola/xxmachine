import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { looksEncrypted, encryptIgSecret, decryptIgSecret, encryptIgSecretOrNull } from './secrets'
import {
  issueOAuthState,
  consumeOAuthState,
  createMemoryStateStore,
  formatSignedState,
  OAuthStateError,
  OAUTH_STATE_TTL_MS,
} from './oauth-state'
import {
  assertSameIgUser,
  IgUserOverwriteError,
  IgUserConflictError,
  persistConnectedAccountForTest,
  createMemoryAccountStore,
  staggerOffsetMs,
  nextRefreshAt,
  REFRESH_BEFORE_EXPIRY_MS,
  buildRefreshUrl,
} from './tokens'
import { isUnsupportedRequest, classifyMetaError, oauthErrorForUi, TESTER_REQUIRED_MESSAGE } from './oauth-errors'

const TEST_KEY_HEX = process.env.ENCRYPTION_KEY!
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex')

describe('token encryption', () => {
  it('never writes plaintext and round-trips', () => {
    const token = 'IGQWE-not-a-real-token-plaintext'
    const stored = encryptIgSecret(token)
    assert.notEqual(stored, token)
    assert.ok(looksEncrypted(stored))
    assert.equal(decryptIgSecret(stored), token)
    assert.equal(encryptIgSecretOrNull(''), null)
  })

  it('reads legacy plaintext until it is re-saved', () => {
    assert.equal(decryptIgSecret('legacy-plain-token'), 'legacy-plain-token')
    assert.equal(looksEncrypted('legacy-plain-token'), false)
  })
})

describe('reconnect overwrite guard', () => {
  it('allows first connect and same-user reconnect', () => {
    assert.doesNotThrow(() => assertSameIgUser(null, 'ig_1'))
    assert.doesNotThrow(() => assertSameIgUser('ig_1', 'ig_1'))
  })

  it('hard-errors when callback IG user id != the record (@@lais overwrite)', () => {
    assert.throws(() => assertSameIgUser('ig_lais', 'ig_other'), IgUserOverwriteError)
  })

  it('unique (user_id, ig_user_id) rejects a second row for the same IG user', async () => {
    const store = createMemoryAccountStore()
    await persistConnectedAccountForTest(store, {
      accountId: 'acc-1',
      userId: 'user-1',
      igUserId: 'ig_lais',
      accessToken: 'token-a',
      expiresAt: new Date(Date.now() + 86400000),
      appId: 'settings-app-id',
    })
    await assert.rejects(
      () => persistConnectedAccountForTest(store, {
        accountId: 'acc-2',
        userId: 'user-1',
        igUserId: 'ig_lais',
        accessToken: 'token-b',
        expiresAt: new Date(Date.now() + 86400000),
        appId: 'settings-app-id',
      }),
      IgUserConflictError,
    )
  })

  it('allows the same IG user id on a different tenant', async () => {
    const store = createMemoryAccountStore()
    await persistConnectedAccountForTest(store, {
      accountId: 'acc-1',
      userId: 'user-1',
      igUserId: 'ig_shared',
      accessToken: 'token-a',
      expiresAt: new Date(Date.now() + 86400000),
      appId: 'app',
    })
    await persistConnectedAccountForTest(store, {
      accountId: 'acc-2',
      userId: 'user-2',
      igUserId: 'ig_shared',
      accessToken: 'token-b',
      expiresAt: new Date(Date.now() + 86400000),
      appId: 'app',
    })
    assert.equal(store.rows.get('acc-2')?.igUserId, 'ig_shared')
  })
})

describe('signed single-use OAuth state', () => {
  it('issues a signed nonce and consumes it once', async () => {
    const store = createMemoryStateStore()
    const key = TEST_KEY
    const state = await issueOAuthState(
      { accountId: 'acc-1', userId: 'user-1' },
      { store, key },
    )
    assert.match(state, /^[0-9a-f]+\.[0-9a-f]{64}$/i)
    const first = await consumeOAuthState(state, { store, key })
    assert.deepEqual(first, { accountId: 'acc-1', userId: 'user-1' })
    await assert.rejects(() => consumeOAuthState(state, { store, key }), OAuthStateError)
  })

  it('rejects replay even if the HMAC is valid', async () => {
    const store = createMemoryStateStore()
    const nonce = 'b'.repeat(64)
    const state = formatSignedState(nonce, TEST_KEY)
    await store.insert({
      nonce,
      accountId: 'acc-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      consumedAt: new Date(),
    })
    await assert.rejects(() => consumeOAuthState(state, { store, key: TEST_KEY }), OAuthStateError)
  })

  it('rejects an expired nonce', async () => {
    const store = createMemoryStateStore()
    const past = new Date(Date.now() - 1000)
    const state = await issueOAuthState(
      { accountId: 'acc-1', userId: 'user-1' },
      { store, now: new Date(past.getTime() - OAUTH_STATE_TTL_MS), key: TEST_KEY },
    )
    await assert.rejects(
      () => consumeOAuthState(state, { store, now: new Date(), key: TEST_KEY }),
      OAuthStateError,
    )
  })

  it('rejects a forged signature', async () => {
    const store = createMemoryStateStore()
    const state = await issueOAuthState(
      { accountId: 'acc-1', userId: 'user-1' },
      { store, key: TEST_KEY },
    )
    const [nonce] = state.split('.')
    const forged = `${nonce}.${createHmac('sha256', Buffer.alloc(32)).update(nonce).digest('hex')}`
    await assert.rejects(() => consumeOAuthState(forged, { store, key: TEST_KEY }), OAuthStateError)
  })
})

describe('tester / refresh helpers', () => {
  it('does not present Unsupported request as a refresh-verb bug', () => {
    const raw = 'Unsupported request - method type: get'
    assert.equal(isUnsupportedRequest(raw), true)
    const classified = classifyMetaError(raw)
    assert.equal(classified.code, 'tester_required')
    assert.match(classified.userMessage, /Instagram Tester/i)
    assert.match(classified.userMessage, /not a refresh-token/i)
    assert.equal(oauthErrorForUi('tester_required'), TESTER_REQUIRED_MESSAGE)
  })

  it('URL-encodes the token on the official GET refresh URL', () => {
    const token = 'abc+def/=ghi'
    const url = buildRefreshUrl(token)
    assert.ok(url.startsWith('https://graph.instagram.com/refresh_access_token?'))
    assert.ok(url.includes('grant_type=ig_refresh_token'))
    assert.ok(url.includes(`access_token=${encodeURIComponent(token)}`))
    assert.ok(!url.includes(`access_token=${token}`))
  })

  it('staggers refresh so many accounts do not share one slot', () => {
    const expires = new Date('2026-10-01T00:00:00.000Z')
    const a = nextRefreshAt(expires, 'account-aaa', new Date('2026-09-01T00:00:00.000Z'))
    const b = nextRefreshAt(expires, 'account-bbb', new Date('2026-09-01T00:00:00.000Z'))
    assert.notEqual(staggerOffsetMs('account-aaa'), staggerOffsetMs('account-bbb'))
    assert.notEqual(a.getTime(), b.getTime())
    const earliest = expires.getTime() - REFRESH_BEFORE_EXPIRY_MS
    assert.ok(a.getTime() >= earliest)
    assert.ok(b.getTime() >= earliest)
  })
})
