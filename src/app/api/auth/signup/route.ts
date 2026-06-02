import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { one } from '@/lib/db'
import { createSession, getSessionUser, setSessionCookie } from '@/lib/session'

interface CreatedUser {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'chatter'
}

interface CountRow { count: string }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      email?: string
      password?: string
      display_name?: string
      role?: 'admin' | 'chatter'
    } | null

    const email = body?.email?.trim().toLowerCase()
    const password = body?.password
    const display_name = body?.display_name?.trim()
    if (!email || !password || !display_name) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'password_too_short' }, { status: 400 })
    }

    // Bootstrap rule: when there are zero users, the first signup becomes admin.
    // Otherwise creating accounts requires an existing admin (handled by separate /api/admin/users route, not here).
    const countRow = await one<CountRow>('select count(*)::text as count from users')
    const total = Number(countRow?.count ?? 0)

    let role: 'admin' | 'chatter'
    let isBootstrap = false
    if (total === 0) {
      role = 'admin'
      isBootstrap = true
    } else {
      // Require requester to be an admin
      const requester = await getSessionUser(req)
      if (!requester || requester.role !== 'admin') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
      role = body?.role === 'admin' ? 'admin' : 'chatter'
    }

    // Check email uniqueness
    const existing = await one(`select 1 from users where lower(email) = $1`, [email])
    if (existing) {
      return NextResponse.json({ error: 'email_taken' }, { status: 409 })
    }

    const hash = await bcrypt.hash(password, 11)
    const created = await one<CreatedUser>(
      `insert into users (email, display_name, role, password_hash)
       values ($1, $2, $3, $4)
       returning id, email, display_name, role`,
      [email, display_name, role, hash],
    )
    if (!created) throw new Error('user_insert_failed')

    // For the bootstrap signup, also start a session so the new admin is logged in.
    const res = NextResponse.json({ ok: true, user: created, bootstrap: isBootstrap })
    if (isBootstrap) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
      const ua = req.headers.get('user-agent')
      const signed = await createSession(created.id, ip ?? undefined, ua ?? undefined)
      setSessionCookie(res, signed)
    }
    return res
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'signup_failed' },
      { status: 500 },
    )
  }
}
