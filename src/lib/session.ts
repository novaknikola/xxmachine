import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { one, query } from './db'
import { SESSION_COOKIE_NAME, packSessionCookie, unpackSessionCookie } from './session-cookie'

const COOKIE_NAME = SESSION_COOKIE_NAME
const SESSION_DAYS = 30

const PROD = process.env.NODE_ENV === 'production'

export { packSessionCookie, unpackSessionCookie }

export interface SessionUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  isOwner: boolean
}

interface SessionRow {
  user_id: string
  expires_at: Date
  email: string
  display_name: string
  role: 'admin' | 'user'
  active: boolean
}

/** True only for the single hardcoded owner account — independent of `role`, since
 *  other accounts (e.g. team admins) must never see owner-only features like Fanvue. */
export function isOwnerEmail(email: string): boolean {
  return !!process.env.OWNER_EMAIL && email === process.env.OWNER_EMAIL
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
    isOwner: isOwnerEmail(row.email),
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

/** API guard: the single owner account only — NOT satisfied by role==='admin'.
 *  Use for anything that must stay invisible to other team admins (e.g. Fanvue routes). */
export async function requireOwner(req: NextRequest): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  if (!user.isOwner) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return user
}
