import { one, query } from '@/lib/db'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!

interface UserGoogleTokens {
  accessToken: string
  refreshToken: string
}

/**
 * Returns a valid Google access token for the user's Drive archive connection.
 * Refreshes and persists when near expiry.
 */
export async function getUserGoogleAccessToken(userId: string): Promise<string> {
  const row = await one<{
    google_access_token: string | null
    google_refresh_token: string | null
    google_token_expiry: Date | null
  }>(
    `SELECT google_access_token, google_refresh_token, google_token_expiry
       FROM users WHERE id = $1`,
    [userId],
  )

  if (!row?.google_refresh_token) {
    throw new Error('Google Drive not connected — reconnect in Settings')
  }

  const expiresAt = row.google_token_expiry ? new Date(row.google_token_expiry).getTime() : 0
  if (row.google_access_token && expiresAt - Date.now() > 60_000) {
    return row.google_access_token
  }

  return persistRefreshedToken(userId, row.google_refresh_token)
}

/** Always refresh — use after a Drive 401 so long My Pod batches don't keep a dead access token. */
export async function forceRefreshUserGoogleAccessToken(userId: string): Promise<string> {
  const row = await one<{ google_refresh_token: string | null }>(
    `SELECT google_refresh_token FROM users WHERE id = $1`,
    [userId],
  )
  if (!row?.google_refresh_token) {
    throw new Error('Google Drive not connected — reconnect in Settings')
  }
  return persistRefreshedToken(userId, row.google_refresh_token)
}

async function persistRefreshedToken(userId: string, refreshToken: string): Promise<string> {
  const tokens = await refreshUserGoogleToken(refreshToken)
  await query(
    `UPDATE users
        SET google_access_token = $2,
            google_refresh_token = COALESCE($3, google_refresh_token),
            google_token_expiry = $4
      WHERE id = $1`,
    [
      userId,
      tokens.accessToken,
      tokens.refreshToken ?? null,
      new Date(Date.now() + tokens.expiresInSec * 1000).toISOString(),
    ],
  )
  return tokens.accessToken
}

async function refreshUserGoogleToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken?: string
  expiresInSec: number
}> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Google token refresh failed')
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSec: data.expires_in ?? 3600,
  }
}

export async function clearUserGoogleDrive(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET google_access_token = NULL,
            google_refresh_token = NULL,
            google_token_expiry = NULL,
            drive_root_folder_id = NULL,
            drive_auto_archive = false
      WHERE id = $1`,
    [userId],
  )
}

export type { UserGoogleTokens }
