import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { one, query } from './db'

const COOKIE_NAME = 'xm_sid'
const SESSION_DAYS = 30

const PROD = process.env.NODE_ENV === 'production'

function secret(): string {
  const s = process.env.FANVUE_SESSION_SECRET // reuse the existing session secret env
  if (!s) throw new Error('FANVUE_SESSION_SECRET is not set')
  return s
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url')
}

export function packSessionCookie(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`
}

export function unpackSessionCookie(raw: string | undefined): string | null {
  if (!raw) return null
  const [id, sig] = raw.split('.')
  if (!id || !sig) return null
  const expected = sign(id)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null
  return id
}

export interface SessionUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'chatter'
}

interface SessionRow {
  user_id: string
  expires_at: Date
  email: string
  display_name: string
  role: 'admin' | 'chatter'
  active: boolean
}

/** Verify the session cookie, return the user or null. Used in API routes & middleware. */
export async function getSessionUser(req?: NextRequest): Promise<SessionUser | null> {
  let raw: string | undefined
  if (req) {
    raw = req.cookies.get(COOKIE_NAME)?.value
  } else {
    const c = await cookies()
    raw = c.get(COOKIE_NAME)?.value
  }
  const sessionId = unpackSessionCookie(raw)
  if (!sessionId) return null

  const row = await one<SessionRow>(
    `select s.user_id, s.expires_at, u.email, u.display_name, u.role, u.active
       from sessions s
       join users u on u.id = s.user_id
      where s.id = $1
        and s.expires_at > now()
      limit 1`,
    [sessionId],
  )
  if (!row || !row.active) return null
  return {
    id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
  }
}

/** Create a new session row and return the signed cookie value. */
export async function createSession(userId: string, ip?: string, userAgent?: string): Promise<string> {
  const r = await one<{ id: string }>(
    `insert into sessions (user_id, expires_at, ip, user_agent)
     values ($1, now() + $2::interval, $3, $4)
     returning id`,
    [userId, `${SESSION_DAYS} days`, ip ?? null, userAgent ?? null],
  )
  if (!r) throw new Error('session_insert_failed')
  await query(`update users set last_login_at = now() where id = $1`, [userId])
  return packSessionCookie(r.id)
}

/** Delete the current session row (logout). */
export async function destroySession(req: NextRequest): Promise<void> {
  const sessionId = unpackSessionCookie(req.cookies.get(COOKIE_NAME)?.value)
  if (sessionId) {
    await query(`delete from sessions where id = $1`, [sessionId])
  }
}

const cookieBaseOpts = {
  httpOnly: true,
  secure: PROD,
  sameSite: 'lax' as const,
  path: '/',
}

export function setSessionCookie(res: NextResponse, signed: string) {
  res.cookies.set(COOKIE_NAME, signed, {
    ...cookieBaseOpts,
    maxAge: SESSION_DAYS * 24 * 3600,
  })
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(COOKIE_NAME, '', { ...cookieBaseOpts, maxAge: 0 })
}

/** API guard: return user or 401 response. */
export async function requireUser(req: NextRequest): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  return user
}

/** API guard: admin only. */
export async function requireAdmin(req: NextRequest): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return user
}
