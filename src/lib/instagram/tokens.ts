import { createHash } from 'node:crypto'
import { one, query, rows } from '@/lib/db'
import { encryptIgSecret, decryptIgSecretOrNull } from '@/lib/instagram/secrets'
import {
  ACCOUNT_OVERWRITE_MESSAGE,
  IG_USER_CONFLICT_MESSAGE,
  classifyMetaError,
  isUnsupportedRequest,
} from '@/lib/instagram/oauth-errors'

export type { TokenStatus } from '@/lib/instagram/oauth-errors'
export { TOKEN_STATUSES, TOKEN_STATUS_LABELS } from '@/lib/instagram/oauth-errors'

/** Long-lived IG tokens last 60 days; refresh around day 45 (15 days of remaining life). */
export const REFRESH_BEFORE_EXPIRY_MS = 15 * 24 * 60 * 60 * 1000
export const STAGGER_WINDOW_MS = 2 * 60 * 60 * 1000
export const REFRESH_BATCH_LIMIT = 8
export const REFRESH_INTER_ACCOUNT_MS = 1500
export const REFRESH_BACKOFF_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]
export const REFRESH_MAX_ATTEMPTS = 5

export class IgUserOverwriteError extends Error {
  readonly code = 'account_overwrite'
  constructor(message = ACCOUNT_OVERWRITE_MESSAGE) {
    super(message)
    this.name = 'IgUserOverwriteError'
  }
}

export class IgUserConflictError extends Error {
  readonly code = 'ig_user_conflict'
  constructor(message = IG_USER_CONFLICT_MESSAGE) {
    super(message)
    this.name = 'IgUserConflictError'
  }
}

export function assertSameIgUser(
  existingIgUserId: string | null | undefined,
  incomingIgUserId: string,
): void {
  if (existingIgUserId && existingIgUserId !== incomingIgUserId) {
    throw new IgUserOverwriteError()
  }
}

/** Deterministic 0..windowMs-1 offset so 100+ accounts do not share one cron slot. */
export function staggerOffsetMs(accountId: string, windowMs = STAGGER_WINDOW_MS): number {
  const hash = createHash('sha256').update(accountId).digest()
  return hash.readUInt32BE(0) % windowMs
}

export function nextRefreshAt(expiresAt: Date, accountId: string, now = new Date()): Date {
  const target = expiresAt.getTime() - REFRESH_BEFORE_EXPIRY_MS + staggerOffsetMs(accountId)
  return new Date(Math.max(now.getTime() + 60_000, target))
}

export function backoffRefreshAt(attempts: number, now = new Date()): Date {
  const idx = Math.min(Math.max(attempts - 1, 0), REFRESH_BACKOFF_MS.length - 1)
  return new Date(now.getTime() + REFRESH_BACKOFF_MS[idx])
}

export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
}

export interface PersistOAuthTokensInput {
  accountId: string
  userId: string
  igUserId: string
  accessToken: string
  expiresAt: Date
  appId: string
  username?: string | null
}

export async function persistOAuthTokens(input: PersistOAuthTokensInput): Promise<void> {
  const account = await one<{
    id: string
    user_id: string | null
    ig_user_id: string | null
  }>(
    `SELECT id, user_id, ig_user_id FROM instagram_accounts WHERE id=$1`,
    [input.accountId],
  )
  if (!account) throw new Error('Instagram account not found')
  if (account.user_id && account.user_id !== input.userId) {
    throw new OAuthTenantError()
  }

  assertSameIgUser(account.ig_user_id, input.igUserId)

  const encrypted = encryptIgSecret(input.accessToken)
  const nextAt = nextRefreshAt(input.expiresAt, input.accountId)

  try {
    const updated = await one<{ id: string }>(
      `UPDATE instagram_accounts
          SET ig_user_id = $1,
              ig_access_token = $2,
              ig_token_expires_at = $3,
              ig_username = COALESCE($4, ig_username),
              name = CASE
                       WHEN name IN ('New Instagram account', '') THEN COALESCE($4, name)
                       ELSE name
                     END,
              ig_token_app_id = $5,
              ig_token_status = 'active',
              ig_token_status_reason = NULL,
              ig_publish_paused = FALSE,
              ig_token_refresh_attempts = 0,
              ig_token_last_refresh_at = now(),
              ig_token_next_refresh_at = $6,
              user_id = COALESCE(user_id, $7)
        WHERE id = $8
        RETURNING id`,
      [
        input.igUserId,
        encrypted,
        input.expiresAt.toISOString(),
        input.username ?? null,
        input.appId,
        nextAt.toISOString(),
        input.userId,
        input.accountId,
      ],
    )
    if (!updated) throw new Error('Instagram account not found')
  } catch (err) {
    if (isUniqueViolation(err)) throw new IgUserConflictError()
    throw err
  }
}

export class OAuthTenantError extends Error {
  readonly code = 'invalid_state'
  constructor() {
    super('OAuth state does not match this account')
    this.name = 'OAuthTenantError'
  }
}

export function buildRefreshUrl(accessToken: string): string {
  const params = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: accessToken,
  })
  return `https://graph.instagram.com/refresh_access_token?${params.toString()}`
}

interface RefreshAccountRow {
  id: string
  user_id: string | null
  ig_access_token: string | null
  ig_token_expires_at: Date | string | null
  ig_token_refresh_attempts: number
  ig_token_status: string
}

export async function markTokenFailure(
  accountId: string,
  status: 'reconnect_required' | 'expired',
  reason: string,
): Promise<void> {
  await query(
    `UPDATE instagram_accounts
        SET ig_token_status = $2,
            ig_token_status_reason = $3,
            ig_publish_paused = TRUE
      WHERE id = $1`,
    [accountId, status, reason],
  )
}

export async function refreshAccountToken(
  accountId: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: true; expiresAt: string } | { ok: false; error: string; code?: string }> {
  const account = await one<RefreshAccountRow>(
    `SELECT id, user_id, ig_access_token, ig_token_expires_at,
            COALESCE(ig_token_refresh_attempts, 0) AS ig_token_refresh_attempts,
            COALESCE(ig_token_status, 'active') AS ig_token_status
       FROM instagram_accounts WHERE id=$1`,
    [accountId],
  )
  if (!account?.ig_access_token) {
    return { ok: false, error: 'Account not connected via OAuth' }
  }

  const token = decryptIgSecretOrNull(account.ig_access_token)
  if (!token) {
    await markTokenFailure(accountId, 'reconnect_required', 'Stored access token could not be decrypted — reconnect required')
    return { ok: false, error: 'Stored access token could not be decrypted — reconnect required', code: 'reconnect_required' }
  }

  await query(
    `UPDATE instagram_accounts SET ig_token_status = 'refreshing' WHERE id = $1`,
    [accountId],
  )

  const fetchImpl = opts?.fetchImpl ?? fetch
  let data: { access_token?: string; expires_in?: number; error?: { message?: string } }
  try {
    const res = await fetchImpl(buildRefreshUrl(token))
    data = await res.json()
    if (!res.ok || !data.access_token) {
      throw new Error(data.error?.message ?? 'Refresh failed')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return handleRefreshFailure(account, message)
  }

  const expiresIn = data.expires_in ?? 5184000
  const expiresAt = new Date(Date.now() + expiresIn * 1000)
  const encrypted = encryptIgSecret(data.access_token)
  const nextAt = nextRefreshAt(expiresAt, accountId)

  await query(
    `UPDATE instagram_accounts
        SET ig_access_token = $1,
            ig_token_expires_at = $2,
            ig_token_status = 'active',
            ig_token_status_reason = NULL,
            ig_publish_paused = FALSE,
            ig_token_refresh_attempts = 0,
            ig_token_last_refresh_at = now(),
            ig_token_next_refresh_at = $3
      WHERE id = $4`,
    [encrypted, expiresAt.toISOString(), nextAt.toISOString(), accountId],
  )

  return { ok: true, expiresAt: expiresAt.toISOString() }
}

async function handleRefreshFailure(
  account: RefreshAccountRow,
  message: string,
): Promise<{ ok: false; error: string; code?: string }> {
  const expiresAt = account.ig_token_expires_at ? new Date(account.ig_token_expires_at) : null
  const expired = !!expiresAt && expiresAt.getTime() <= Date.now()

  if (isUnsupportedRequest(message)) {
    const { userMessage } = classifyMetaError(message)
    await markTokenFailure(account.id, expired ? 'expired' : 'reconnect_required', userMessage)
    return { ok: false, error: userMessage, code: expired ? 'expired' : 'tester_required' }
  }

  const attempts = (account.ig_token_refresh_attempts ?? 0) + 1
  if (attempts >= REFRESH_MAX_ATTEMPTS) {
    const status = expired ? 'expired' : 'reconnect_required'
    const reason = `Token refresh failed after ${attempts} attempts: ${message}. Publishing is paused until you reconnect.`
    await markTokenFailure(account.id, status, reason)
    return { ok: false, error: reason, code: status }
  }

  const nextAt = backoffRefreshAt(attempts)
  await query(
    `UPDATE instagram_accounts
        SET ig_token_status = 'active',
            ig_token_status_reason = $2,
            ig_token_refresh_attempts = $3,
            ig_token_next_refresh_at = $4
      WHERE id = $1`,
    [account.id, `Refresh retry ${attempts}/${REFRESH_MAX_ATTEMPTS}: ${message}`, attempts, nextAt.toISOString()],
  )
  return { ok: false, error: message }
}

export async function refreshDueTokens(opts?: {
  limit?: number
  staggerMs?: number
  fetchImpl?: typeof fetch
  now?: Date
}): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const limit = opts?.limit ?? REFRESH_BATCH_LIMIT
  const staggerMs = opts?.staggerMs ?? REFRESH_INTER_ACCOUNT_MS
  const now = opts?.now ?? new Date()

  const due = await rows<{ id: string }>(
    `SELECT id FROM instagram_accounts
      WHERE ig_access_token IS NOT NULL
        AND COALESCE(ig_token_status, 'active') NOT IN ('reconnect_required', 'expired')
        AND (
          ig_token_next_refresh_at IS NULL
          OR ig_token_next_refresh_at <= $1
          OR ig_token_expires_at <= $2
        )
      ORDER BY ig_token_next_refresh_at NULLS FIRST, id
      LIMIT $3`,
    [now.toISOString(), new Date(now.getTime() + REFRESH_BEFORE_EXPIRY_MS).toISOString(), limit],
  )

  let refreshed = 0
  let failed = 0
  for (let i = 0; i < due.length; i++) {
    const result = await refreshAccountToken(due[i].id, { fetchImpl: opts?.fetchImpl })
    if (result.ok) refreshed++
    else failed++
    if (i < due.length - 1 && staggerMs > 0) {
      await new Promise(resolve => setTimeout(resolve, staggerMs))
    }
  }

  return { refreshed, failed, skipped: 0 }
}

export function publishingBlockedReason(account: {
  ig_publish_paused?: boolean | null
  ig_token_status?: string | null
  ig_token_status_reason?: string | null
}): string | null {
  const status = account.ig_token_status
  if (status === 'reconnect_required' || status === 'expired' || account.ig_publish_paused) {
    return account.ig_token_status_reason
      ?? (status === 'expired'
        ? 'Instagram token expired — reconnect required. Publishing is paused.'
        : 'Instagram reconnect required. Publishing is paused.')
  }
  return null
}

/** In-memory account store used by unique-constraint / overwrite unit tests. */
export interface MemoryAccountRow {
  id: string
  userId: string
  igUserId: string | null
  accessToken: string | null
  expiresAt: Date | null
  appId: string | null
}

export interface MemoryAccountStore {
  rows: Map<string, MemoryAccountRow>
}

export function createMemoryAccountStore(seed: MemoryAccountRow[] = []): MemoryAccountStore {
  const rows = new Map<string, MemoryAccountRow>()
  for (const r of seed) rows.set(r.id, { ...r })
  return { rows }
}

export async function persistConnectedAccountForTest(
  store: MemoryAccountStore,
  input: PersistOAuthTokensInput,
): Promise<void> {
  const existing = store.rows.get(input.accountId) ?? {
    id: input.accountId,
    userId: input.userId,
    igUserId: null,
    accessToken: null,
    expiresAt: null,
    appId: null,
  }
  assertSameIgUser(existing.igUserId, input.igUserId)
  for (const row of store.rows.values()) {
    if (row.id === input.accountId) continue
    if (row.userId === input.userId && row.igUserId === input.igUserId) {
      throw new IgUserConflictError()
    }
  }
  store.rows.set(input.accountId, {
    ...existing,
    userId: input.userId,
    igUserId: input.igUserId,
    accessToken: encryptIgSecret(input.accessToken),
    expiresAt: input.expiresAt,
    appId: input.appId,
  })
}
