import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Session cookie signing, isolated from the database layer so `proxy.ts` can
 * verify cookies without pulling in `pg`.
 */

export const SESSION_COOKIE_NAME = 'xm_sid'

function sign(value: string): string {
  const s = process.env.FANVUE_SESSION_SECRET // reuse the existing session secret env
  if (!s) throw new Error('FANVUE_SESSION_SECRET is not set')
  return createHmac('sha256', s).update(value).digest('base64url')
}

export function packSessionCookie(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`
}

/**
 * Verify the cookie signature and return the session id, or null when the
 * cookie is missing, malformed or forged. Does not check the database — a
 * returned id still has to be looked up in `sessions`.
 */
export function unpackSessionCookie(raw: string | undefined): string | null {
  if (!raw) return null
  const [id, sig] = raw.split('.')
  if (!id || !sig) return null

  let expected: string
  try {
    expected = sign(id)
  } catch {
    // No secret configured — every cookie is untrustworthy.
    return null
  }

  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null
  return id
}
