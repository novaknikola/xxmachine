import { cookies } from 'next/headers'

const FANVUE_API = 'https://api.fanvue.com'
const FANVUE_AUTH = 'https://auth.fanvue.com'
const API_VERSION = '2025-06-26'

export const FANVUE_CLIENT_ID = process.env.FANVUE_CLIENT_ID!
export const FANVUE_CLIENT_SECRET = process.env.FANVUE_CLIENT_SECRET!
export const FANVUE_REDIRECT_URI = process.env.FANVUE_REDIRECT_URI ?? 'http://localhost:3000/api/fanvue/callback'

export interface TokenSet {
  access_token: string
  refresh_token: string
  expires_at: number
}

// ─── PKCE ─────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString('base64url')
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(digest).toString('base64url')
}

// ─── Auth URL ─────────────────────────────────────────────────

export function buildAuthUrl(codeChallenge: string, state: string): string {
  const url = new URL(`${FANVUE_AUTH}/oauth2/auth`)
  url.searchParams.set('client_id', FANVUE_CLIENT_ID)
  url.searchParams.set('redirect_uri', FANVUE_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'read:self read:creator write:creator read:chat write:chat read:fan read:media read:insights')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

// ─── Token Exchange ───────────────────────────────────────────

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const credentials = Buffer.from(`${FANVUE_CLIENT_ID}:${FANVUE_CLIENT_SECRET}`).toString('base64')
  const res = await fetch(`${FANVUE_AUTH}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: FANVUE_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description ?? JSON.stringify(data))
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const credentials = Buffer.from(`${FANVUE_CLIENT_ID}:${FANVUE_CLIENT_SECRET}`).toString('base64')
  const res = await fetch(`${FANVUE_AUTH}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description ?? JSON.stringify(data))
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

// ─── Get token from cookies ───────────────────────────────────

async function getValidToken(): Promise<string> {
  const cookieStore = await cookies()
  const accessToken = cookieStore.get('fanvue_access_token')?.value
  const refreshToken = cookieStore.get('fanvue_refresh_token')?.value
  const expiresAt = Number(cookieStore.get('fanvue_expires_at')?.value ?? 0)

  if (!accessToken) throw new Error('NOT_CONNECTED')

  // Refresh if expiring in < 60s
  if (expiresAt - Date.now() < 60_000 && refreshToken) {
    const tokens = await refreshAccessToken(refreshToken)
    const secure = process.env.NODE_ENV === 'production'
    const maxAge = 60 * 60 * 24 * 30
    cookieStore.set('fanvue_access_token', tokens.access_token, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_refresh_token', tokens.refresh_token, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_expires_at', String(tokens.expires_at), { httpOnly: true, secure, maxAge })
    return tokens.access_token
  }

  return accessToken
}

// ─── Authenticated fetch ──────────────────────────────────────

export async function fanvueFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getValidToken()
  return fetch(`${FANVUE_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Fanvue-API-Version': API_VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
}

// ─── API Methods ──────────────────────────────────────────────

export async function isConnected(): Promise<boolean> {
  try {
    const cookieStore = await cookies()
    return !!cookieStore.get('fanvue_access_token')?.value
  } catch { return false }
}

export async function getAgencyCreators(page = 1) {
  const res = await fanvueFetch(`/creators?page=${page}&size=50`)
  if (!res.ok) throw new Error('Failed to fetch creators')
  return res.json()
}

export async function getCreatorChats(creatorUuid: string, page = 1) {
  const res = await fanvueFetch(`/agency/creators/${creatorUuid}/chats?page=${page}&size=50`)
  if (!res.ok) throw new Error('Failed to fetch chats')
  return res.json()
}

export async function getCreatorMessages(creatorUuid: string, fanUuid: string, page = 1) {
  const res = await fanvueFetch(`/agency/creators/${creatorUuid}/messages?userUuid=${fanUuid}&page=${page}&size=50`)
  if (!res.ok) throw new Error('Failed to fetch messages')
  return res.json()
}

export async function sendMessageAsCreator(creatorUuid: string, fanUuid: string, text: string) {
  const res = await fanvueFetch(`/agency/creators/${creatorUuid}/messages`, {
    method: 'POST',
    body: JSON.stringify({ userUuid: fanUuid, text }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(JSON.stringify(err))
  }
  return res.json()
}

export async function getCreatorTopSpenders(creatorUuid: string) {
  const res = await fanvueFetch(`/agency/creators/${creatorUuid}/top-spenders`)
  if (!res.ok) throw new Error('Failed to fetch top spenders')
  return res.json()
}

export async function getCreatorEarnings(creatorUuid: string) {
  const res = await fanvueFetch(`/agency/creators/${creatorUuid}/earnings`)
  if (!res.ok) throw new Error('Failed to fetch earnings')
  return res.json()
}

export async function getChatterLeaderboard() {
  const res = await fanvueFetch('/agency/chatter-leaderboard')
  if (!res.ok) throw new Error('Failed to fetch leaderboard')
  return res.json()
}

export async function getTeamMembers() {
  const res = await fanvueFetch('/agency/team-members')
  if (!res.ok) throw new Error('Failed to fetch team members')
  return res.json()
}

// ─── Creator-direct endpoints (when connected as creator) ─────

export async function getChats(filter?: string, page = 1) {
  const params = new URLSearchParams({ page: String(page), size: '50' })
  if (filter) params.set('filter', filter)
  const res = await fanvueFetch(`/chats?${params}`)
  if (!res.ok) throw new Error('Failed to fetch chats: ' + await res.text())
  return res.json()
}

export async function getChatMessages(fanUuid: string, page = 1) {
  const res = await fanvueFetch(`/chats/${fanUuid}/messages?page=${page}&size=50`)
  if (!res.ok) throw new Error('Failed to fetch messages: ' + await res.text())
  return res.json()
}

export async function sendMessage(fanUuid: string, text: string) {
  const res = await fanvueFetch(`/chats/${fanUuid}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error('Failed to send message: ' + await res.text())
  return res.json()
}

export async function getCurrentUser() {
  const res = await fanvueFetch('/users/me')
  if (!res.ok) throw new Error('Failed to fetch user: ' + await res.text())
  return res.json()
}

export async function getFanInsights(fanUuid: string) {
  const res = await fanvueFetch(`/insights/fans/${fanUuid}`)
  if (!res.ok) return null
  return res.json()
}