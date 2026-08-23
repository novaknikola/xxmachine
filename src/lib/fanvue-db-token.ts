import { query, one } from './db'
import { encryptSecret, decryptSecret } from './secret-crypto'
import { FANVUE_TOKEN_URL, FANVUE_API_BASE, fanvueHeaders } from './fanvue-server'

const CLIENT_ID = process.env.FANVUE_CLIENT_ID!
const CLIENT_SECRET = process.env.FANVUE_CLIENT_SECRET!
const FANVUE_SECRET_PURPOSE = 'xm_fanvue_v1'

interface ConnectionRow {
  access_token_encrypted: string
  refresh_token_encrypted: string
  expires_at: string
}

/** Reads back the currently stored (decrypted) refresh token, if any. Fanvue's token endpoint
 *  only issues a *new* refresh_token on first consent — a reconnect legitimately returns
 *  access_token only, and the client is expected to keep using the one it already has. */
export async function getStoredRefreshToken(): Promise<string | null> {
  const row = await one<{ refresh_token_encrypted: string }>(
    `select refresh_token_encrypted from fanvue_connection where id = 1`,
  )
  return row ? decryptSecret(row.refresh_token_encrypted, FANVUE_SECRET_PURPOSE) : null
}

/** Called once right after OAuth exchange (in addition to setting cookies) — makes the
 *  connection usable from contexts with no browser cookies, e.g. a cron worker.
 *  `refreshToken` may be undefined on a reconnect (see getStoredRefreshToken) — falls back
 *  to whatever is already stored, and only fails if there's genuinely none anywhere. */
export async function saveFanvueConnectionToDb(
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: number,
): Promise<void> {
  const resolvedRefreshToken = refreshToken ?? await getStoredRefreshToken()
  if (!resolvedRefreshToken) {
    throw new Error('no_refresh_token_available: Fanvue returned no refresh_token and none is stored yet')
  }
  await query(
    `insert into fanvue_connection (id, access_token_encrypted, refresh_token_encrypted, expires_at, updated_at)
     values (1, $1, $2, $3, now())
     on conflict (id) do update set
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       expires_at = excluded.expires_at,
       updated_at = now()`,
    [encryptSecret(accessToken, FANVUE_SECRET_PURPOSE), encryptSecret(resolvedRefreshToken, FANVUE_SECRET_PURPOSE), expiresAt],
  )
}

/** DB-backed equivalent of fanvue-server.ts's getFanvueAccessToken — for contexts with no
 *  NextRequest/cookies (cron ticks, background workers). Refreshes and persists in place when
 *  the stored token is expiring. Returns null if nothing has ever been connected. */
export async function getFanvueAccessTokenFromDb(): Promise<string | null> {
  const row = await one<ConnectionRow>(
    `select access_token_encrypted, refresh_token_encrypted, expires_at from fanvue_connection where id = 1`,
  )
  if (!row) return null

  const expiresAt = Number(row.expires_at)
  if (Date.now() < expiresAt) {
    return decryptSecret(row.access_token_encrypted, FANVUE_SECRET_PURPOSE)
  }

  const refreshToken = decryptSecret(row.refresh_token_encrypted, FANVUE_SECRET_PURPOSE)
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const res = await fetch(FANVUE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!res.ok) return null
  const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!data.access_token) return null

  const newExpiresAt = Date.now() + Math.max(60, Number(data.expires_in ?? 3600) - 60) * 1000
  await saveFanvueConnectionToDb(data.access_token, data.refresh_token ?? refreshToken, newExpiresAt)
  return data.access_token
}

interface AgencyCreator {
  uuid: string
  handle?: string
  displayName?: string
  avatarUrl?: string
}

/** Refreshes the fanvue_creators cache from the live agency creator list. Called after
 *  connect, and safe to call any time a fresh access token is available. */
export async function syncFanvueCreatorsToDb(accessToken: string): Promise<number> {
  let page = 1
  let synced = 0
  while (page <= 20) {
    const res = await fetch(`${FANVUE_API_BASE}/creators?page=${page}&size=50`, {
      headers: fanvueHeaders(accessToken),
    })
    if (!res.ok) break
    const data = await res.json() as { data?: AgencyCreator[]; pagination?: { hasMore?: boolean } }
    const creators = data.data ?? []
    for (const c of creators) {
      await query(
        `insert into fanvue_creators (creator_uuid, handle, display_name, avatar_url, synced_at)
         values ($1, $2, $3, $4, now())
         on conflict (creator_uuid) do update set
           handle = excluded.handle,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           synced_at = now()`,
        [c.uuid, c.handle ?? null, c.displayName ?? null, c.avatarUrl ?? null],
      )
      synced++
    }
    if (!data.pagination?.hasMore || creators.length === 0) break
    page++
  }
  return synced
}
