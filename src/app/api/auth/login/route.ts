import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { one } from '@/lib/db'
import { createSession, setSessionCookie } from '@/lib/session'

interface UserRow {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'chatter'
  password_hash: string
  active: boolean
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { email?: string; password?: string } | null
    const email = body?.email?.trim().toLowerCase()
    const password = body?.password
    if (!email || !password) {
      return NextResponse.json({ error: 'missing_credentials' }, { status: 400 })
    }

    const user = await one<UserRow>(
      `select id, email, display_name, role, password_hash, active
         from users where lower(email) = $1 limit 1`,
      [email],
    )
    if (!user || !user.active) {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    }

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const ua = req.headers.get('user-agent')
    const signed = await createSession(user.id, ip ?? undefined, ua ?? undefined)

    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
    })
    setSessionCookie(res, signed)
    return res
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'login_failed' },
      { status: 500 },
    )
  }
}
