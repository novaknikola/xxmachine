import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { createSession, setSessionCookie, isOwnerEmail } from '@/lib/session'

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

    const user = await one<UserRow>(
      `SELECT id, email, display_name, role, totp_secret, totp_enabled, active, subscription_status
       FROM users WHERE id = $1`,
      [userId],
    )

    if (!user || !user.active) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }
    if (!user.totp_secret) {
      return NextResponse.json({ error: 'totp_not_configured' }, { status: 400 })
    }

    const secret = decrypt(user.totp_secret)
    const valid: boolean = authenticator.verify({ token: code, secret })

    if (!valid) {
      return NextResponse.json({ error: 'invalid_code' }, { status: 400 })
    }

    // Activate 2FA on first verify (signup flow)
    if (!user.totp_enabled) {
      await one(`UPDATE users SET totp_enabled = true WHERE id = $1`, [userId])
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
        isOwner: isOwnerEmail(user.email),
      },
    })
    setSessionCookie(res, signed)
    return res
  } catch (err) {
    console.error('[auth/signup/verify]', err)
    return NextResponse.json({ error: 'verify_failed' }, { status: 500 })
  }
}
