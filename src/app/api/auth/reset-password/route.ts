import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { one } from '@/lib/db'
import { decrypt } from '@/lib/crypto'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib')

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      email?: string
      code?: string
      newPassword?: string
    } | null

    const email = body?.email?.trim().toLowerCase()
    const code = body?.code?.trim()
    const newPassword = body?.newPassword

    if (!email || !code || !newPassword) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'password_too_short' }, { status: 400 })
    }

    const user = await one<{ id: string; totp_secret: string | null; totp_enabled: boolean; active: boolean }>(
      `SELECT id, totp_secret, totp_enabled, active FROM users WHERE lower(email) = $1`,
      [email],
    )

    // Always return same response to prevent email enumeration
    if (!user || !user.active || !user.totp_enabled || !user.totp_secret) {
      return NextResponse.json({ ok: true })
    }

    const secret = decrypt(user.totp_secret)
    const valid: boolean = authenticator.verify({ token: code, secret })
    if (!valid) {
      return NextResponse.json({ ok: true }) // same response — no oracle
    }

    const hash = await bcrypt.hash(newPassword, 11)
    await one(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id])

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[auth/reset-password]', err)
    return NextResponse.json({ error: 'reset_failed' }, { status: 500 })
  }
}
