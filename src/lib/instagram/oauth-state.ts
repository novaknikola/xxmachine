import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { one, query } from '@/lib/db'

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export class OAuthStateError extends Error {
  readonly code = 'invalid_state'
  constructor(message = 'Invalid or expired OAuth state') {
    super(message)
    this.name = 'OAuthStateError'
  }
}

export interface OAuthStateRecord {
  nonce: string
  accountId: string
  userId: string
  expiresAt: Date
  consumedAt: Date | null
}

export interface OAuthStateStore {
  insert(row: OAuthStateRecord): Promise<void>
  /**
   * Atomically mark `nonce` consumed if it is unused and unexpired.
   * Returns the row on success, null on miss / replay / expiry.
   */
  consume(nonce: string, now: Date): Promise<OAuthStateRecord | null>
}

function hmacKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set')
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  return key
}

export function signNonce(nonce: string, key = hmacKey()): string {
  return createHmac('sha256', key).update(nonce).digest('hex')
}

export function formatSignedState(nonce: string, key = hmacKey()): string {
  return `${nonce}.${signNonce(nonce, key)}`
}

export function verifySignedState(state: string, key = hmacKey()): string {
  const dot = state.lastIndexOf('.')
  if (dot <= 0) throw new OAuthStateError()
  const nonce = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  if (!/^[0-9a-f]{32,}$/i.test(nonce) || !/^[0-9a-f]{64}$/i.test(sig)) {
    throw new OAuthStateError()
  }
  const expected = signNonce(nonce, key)
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OAuthStateError()
  }
  return nonce
}

export async function issueOAuthState(
  input: { accountId: string; userId: string },
  opts?: { store?: OAuthStateStore; now?: Date; ttlMs?: number; key?: Buffer },
): Promise<string> {
  const now = opts?.now ?? new Date()
  const ttlMs = opts?.ttlMs ?? OAUTH_STATE_TTL_MS
  const nonce = randomBytes(32).toString('hex')
  const row: OAuthStateRecord = {
    nonce,
    accountId: input.accountId,
    userId: input.userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    consumedAt: null,
  }
  const store = opts?.store ?? pgStateStore
  await store.insert(row)
  return formatSignedState(nonce, opts?.key ?? hmacKey())
}

export async function consumeOAuthState(
  state: string,
  opts?: { store?: OAuthStateStore; now?: Date; key?: Buffer },
): Promise<{ accountId: string; userId: string }> {
  const nonce = verifySignedState(state, opts?.key ?? hmacKey())
  const now = opts?.now ?? new Date()
  const store = opts?.store ?? pgStateStore
  const row = await store.consume(nonce, now)
  if (!row) throw new OAuthStateError()
  return { accountId: row.accountId, userId: row.userId }
}

export const pgStateStore: OAuthStateStore = {
  async insert(row) {
    await query(
      `INSERT INTO instagram_oauth_states (nonce, account_id, user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [row.nonce, row.accountId, row.userId, row.expiresAt.toISOString()],
    )
  },
  async consume(nonce, now) {
    const row = await one<{
      nonce: string
      account_id: string
      user_id: string
      expires_at: Date
      consumed_at: Date | null
    }>(
      `UPDATE instagram_oauth_states
          SET consumed_at = $2
        WHERE nonce = $1
          AND consumed_at IS NULL
          AND expires_at > $2
        RETURNING nonce, account_id, user_id, expires_at, consumed_at`,
      [nonce, now.toISOString()],
    )
    if (!row) return null
    return {
      nonce: row.nonce,
      accountId: row.account_id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      consumedAt: row.consumed_at ? new Date(row.consumed_at) : now,
    }
  },
}

/** In-memory store for unit tests (same consume semantics as Postgres). */
export function createMemoryStateStore(seed: OAuthStateRecord[] = []): OAuthStateStore {
  const rows = new Map<string, OAuthStateRecord>()
  for (const r of seed) rows.set(r.nonce, { ...r })
  return {
    async insert(row) {
      if (rows.has(row.nonce)) throw new Error('duplicate nonce')
      rows.set(row.nonce, { ...row })
    },
    async consume(nonce, now) {
      const row = rows.get(nonce)
      if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return null
      const consumed: OAuthStateRecord = { ...row, consumedAt: now }
      rows.set(nonce, consumed)
      return consumed
    },
  }
}
