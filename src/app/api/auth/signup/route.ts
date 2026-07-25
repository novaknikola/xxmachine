import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import QRCode from 'qrcode'
import { one } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { createSession, setSessionCookie } from '@/lib/session'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib')

interface CountRow { count: string }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      email?: string
      password?: string
      display_name?: string
      telegram?: string
    } | null

    const email = body?.email?.trim().toLowerCase()
    const password = body?.password
    const display_name = body?.display_name?.trim()
    const telegram = body?.telegram?.trim() || null

    if (!email || !password || !display_name) {
      return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'password_too_short' }, { status: 400 })
    }

    // Email uniqueness check
    const existing = await one(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])
    if (existing) {
      return NextResponse.json({ error: 'email_taken' }, { status: 409 })
    }

    // Bootstrap: first user becomes admin
    const countRow = await one<CountRow>('SELECT count(*)::text AS count FROM users')
    const total = Number(countRow?.count ?? 0)
    const role = total === 0 ? 'admin' : 'user'

    // Generate TOTP secret and encrypt it
    const totpSecret: string = authenticator.generateSecret()
    const encryptedSecret = encrypt(totpSecret)

    const hash = await bcrypt.hash(password, 11)
    const created = await one<{ id: string }>(
      `INSERT INTO users (email, display_name, role, password_hash, telegram, totp_secret, totp_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING id`,
      [email, display_name, role, hash, telegram, encryptedSecret],
    )
    if (!created) throw new Error('user_insert_failed')

    // Build otpauth URL for QR code
    const otpauthUrl = authenticator.keyuri(email, 'XXmachine', totpSecret)
    const qrDataUrl: string = await QRCode.toDataURL(otpauthUrl)

    return NextResponse.json({
      ok: true,
      userId: created.id,
      qrDataUrl,
      otpauthUrl,
      isFirstUser: role === 'admin',
    })
  } catch (err) {
    console.error('[auth/signup]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'signup_failed' },
      { status: 500 },
    )
  }
}
