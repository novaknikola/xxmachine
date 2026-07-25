import { createHmac, timingSafeEqual } from 'node:crypto'
import type { NextResponse } from 'next/server'

/**
 * Binds the TOTP step to a successful password step. Without this the verify
 * endpoint accepts a bare user id, which lets anyone who knows an id brute
 * force codes without ever proving they know the password.
 */

export const TWO_FACTOR_COOKIE = 'xm_2fa'
const TTL_SECONDS = 300

const PROD = process.env.NODE_ENV === 'production'

function sign(payload: string): string {
  const s = process.env.FANVUE_SESSION_SECRET
  if (!s) throw new Error('FANVUE_SESSION_SECRET is not set')
  return createHmac('sha256', s).update(payload).digest('base64url')
}

function issue(userId: string): string {
  const payload = `${userId}.${Date.now() + TTL_SECONDS * 1000}`
  return `${payload}.${sign(payload)}`
}

/** Returns the user id the ticket was issued for, or null when invalid or expired. */
export function readTwoFactorTicket(raw: string | undefined): string | null {
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null

  const [userId, expRaw, sig] = parts
  let expected: string
  try {
    expected = sign(`${userId}.${expRaw}`)
  } catch {
    return null
  }

  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || Date.now() > exp) return null
  return userId
}

const cookieOpts = {
  httpOnly: true,
  secure: PROD,
  sameSite: 'lax' as const,
  path: '/',
}

export function setTwoFactorCookie(res: NextResponse, userId: string): void {
  res.cookies.set(TWO_FACTOR_COOKIE, issue(userId), { ...cookieOpts, maxAge: TTL_SECONDS })
}

export function clearTwoFactorCookie(res: NextResponse): void {
  res.cookies.set(TWO_FACTOR_COOKIE, '', { ...cookieOpts, maxAge: 0 })
}
