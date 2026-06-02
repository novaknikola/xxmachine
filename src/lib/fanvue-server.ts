import type { NextRequest, NextResponse } from 'next/server'

export const FANVUE_TOKEN_URL = 'https://auth.fanvue.com/oauth2/token'
export const FANVUE_API_BASE = 'https://api.fanvue.com'
export const FANVUE_API_VERSION = '2025-06-26'

const CLIENT_ID = process.env.FANVUE_CLIENT_ID!
const CLIENT_SECRET = process.env.FANVUE_CLIENT_SECRET!
const PROD = process.env.NODE_ENV === 'production'

export function fanvueHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Fanvue-API-Version': FANVUE_API_VERSION,
  }
}

export interface CookieDelta {
  name: string
  value: string
  opts: {
    httpOnly: boolean
    secure: boolean
    sameSite: 'lax'
    path: string
    maxAge: number
  }
}

export interface TokenContext {
  accessToken: string | null
  cookieDeltas: CookieDelta[]
}

export async function getFanvueAccessToken(req: NextRequest): Promise<TokenContext> {
  const access = req.cookies.get('fv_access_token')?.value
  const refresh = req.cookies.get('fv_refresh_token')?.value
  const expiresAt = Number(req.cookies.get('fv_expires_at')?.value ?? 0)

  if (access && Date.now() < expiresAt) {
    return { accessToken: access, cookieDeltas: [] }
  }
  if (!refresh) {
    return { accessToken: null, cookieDeltas: [] }
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const refreshRes = await fetch(FANVUE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
    }),
  })

  if (!refreshRes.ok) return { accessToken: null, cookieDeltas: [] }
  const data = await refreshRes.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) return { accessToken: null, cookieDeltas: [] }

  const accessSecs = Number(data.expires_in ?? 3600)
  const newExpiresAt = Date.now() + Math.max(60, accessSecs - 60) * 1000
  const deltas: CookieDelta[] = [
    { name: 'fv_access_token', value: data.access_token, opts: { httpOnly: true, secure: PROD, sameSite: 'lax', path: '/', maxAge: accessSecs } },
    { name: 'fv_expires_at', value: String(newExpiresAt), opts: { httpOnly: false, secure: PROD, sameSite: 'lax', path: '/', maxAge: 60 * 24 * 3600 } },
  ]
  if (data.refresh_token) {
    deltas.push({ name: 'fv_refresh_token', value: data.refresh_token, opts: { httpOnly: true, secure: PROD, sameSite: 'lax', path: '/', maxAge: 60 * 24 * 3600 } })
  }
  return { accessToken: data.access_token, cookieDeltas: deltas }
}

export function applyCookies(res: NextResponse, deltas: CookieDelta[]) {
  for (const c of deltas) res.cookies.set(c.name, c.value, c.opts)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Fetch a Fanvue endpoint with auth + version headers, retrying on 429 with backoff. */
export async function fanvueFetch(
  path: string,
  accessToken: string,
  init: RequestInit & { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const { maxRetries = 2, baseDelayMs = 1500, headers, ...rest } = init
  const mergedHeaders = { ...fanvueHeaders(accessToken), ...(headers as Record<string, string> | undefined) }
  const url = path.startsWith('http') ? path : `${FANVUE_API_BASE}${path}`
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { ...rest, headers: mergedHeaders })
    if (res.status !== 429) return res
    if (attempt === maxRetries) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * Math.pow(2, attempt)
    await sleep(wait)
  }
  // unreachable
  return fetch(url, { ...rest, headers: mergedHeaders })
}
