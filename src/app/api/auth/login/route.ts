import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { one } from '@/lib/db'
import { createSession, setSessionCookie } from '@/lib/session'

interface UserRow {
  id: string
  email: string
  display_name: string
  role: string
  password_hash: string
  active: boolean
  totp_enabled: boolean
  subscription_status: string
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
      `SELECT id, email, display_name, role, password_hash, active, totp_enabled, subscription_status
       FROM users WHERE lower(email) = $1 LIMIT 1`,
      [email],
    )

    if (!user || !user.active) {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    }

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    }

    // If 2FA is enabled, require a second step — do NOT create a session yet.
    // The ticket cookie proves to /login/verify that this password step succeeded.
    if (user.totp_enabled) {
      const res = NextResponse.json({ requires2fa: true, userId: user.id })
      setTwoFactorCookie(res, user.id)
      return res
    }

    // 2FA not yet configured (legacy admin bootstrap case) — log in directly
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
    const ua = req.headers.get('user-agent') ?? undefined
    const signed = await createSession(user.id, ip, ua)

    const res = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        subscription_status: user.subscription_status,
      },
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
