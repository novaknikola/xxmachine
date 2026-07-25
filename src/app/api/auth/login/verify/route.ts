import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { createSession, setSessionCookie } from '@/lib/session'
import { clearTwoFactorCookie, readTwoFactorTicket } from '@/lib/two-factor-ticket'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib')

interface UserRow {
  id: string
  email: string
  display_name: string
  role: string
  totp_secret: string | null
  totp_enabled: boolean
  active: boolean
  subscription_status: string
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { userId?: string; code?: string } | null
    const userId = body?.userId?.trim()
    const code = body?.code?.trim()

    if (!userId || !code) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
    }

    const ticketUserId = readTwoFactorTicket(req.cookies.get('xm_2fa')?.value)
    if (!ticketUserId || ticketUserId !== userId) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 401 })
    }

    const user = await one<UserRow>(
      `SELECT id, email, display_name, role, totp_secret, totp_enabled, active, subscription_status
       FROM users WHERE id = $1`,
      [userId],
    )

    if (!user || !user.active || !user.totp_enabled || !user.totp_secret) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }

    const secret = decrypt(user.totp_secret)
    const valid: boolean = authenticator.verify({ token: code, secret })

    if (!valid) {
      return NextResponse.json({ error: 'invalid_code' }, { status: 400 })
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
    const ua = req.headers.get('user-agent') ?? undefined
    const signed = await createSession(userId, ip, ua)

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
    clearTwoFactorCookie(res)
    return res
  } catch (err) {
    console.error('[auth/login/verify]', err)
    return NextResponse.json({ error: 'verify_failed' }, { status: 500 })
  }
}
