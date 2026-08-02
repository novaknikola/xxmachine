import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { requireUser } from '@/lib/session'
import { one, rows } from '@/lib/db'
import { encryptOrNull } from '@/lib/crypto'
import bcrypt from 'bcryptjs'

const KEY_FIELDS = [
  'wavespeed_api_key',
  'hf_token',
  'apify_api_key',
  'ig_app_id',
  'ig_app_secret',
  'threads_app_id',
  'threads_app_secret',
] as const
type KeyField = typeof KEY_FIELDS[number]

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const [userRow, settingsRow] = await Promise.all([
    one<{
      display_name: string
      telegram: string | null
      totp_enabled: boolean
      subscription_status: string
      default_reference_image_url: string | null
    }>(
      `SELECT display_name, telegram, totp_enabled, subscription_status,
              default_reference_image_url
         FROM users WHERE id = $1`,
      [auth.id],
    ),
    one<Record<string, string | null>>(
      `SELECT ${KEY_FIELDS.join(', ')} FROM user_settings WHERE user_id = $1`,
      [auth.id],
    ),
  ])

  const apiKeyPresence: Record<string, boolean> = {}
  for (const field of KEY_FIELDS) {
    apiKeyPresence[field] = Boolean(settingsRow?.[field])
  }

  return NextResponse.json({
    profile: {
      display_name: userRow?.display_name ?? '',
      telegram: userRow?.telegram ?? '',
      totp_enabled: userRow?.totp_enabled ?? false,
      subscription_status: userRow?.subscription_status ?? 'inactive',
    },
    apiKeys: apiKeyPresence,
    copyPaste: {
      default_reference_image_url: userRow?.default_reference_image_url ?? null,
    },
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json() as { type?: string } & Record<string, unknown>

  // ── Profile update ────────────────────────────────────────────
  if (body.type === 'profile') {
    const { display_name, telegram } = body as { display_name?: string; telegram?: string }
    await one(
      `UPDATE users SET display_name = COALESCE($1, display_name), telegram = $2 WHERE id = $3`,
      [display_name?.trim() ?? null, telegram?.trim() ?? null, auth.id],
    )
    return NextResponse.json({ ok: true })
  }

  // ── Password change (requires TOTP) ───────────────────────────
  if (body.type === 'password') {
    const { newPassword, totpCode } = body as { newPassword?: string; totpCode?: string }
    if (!newPassword || newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    if (!totpCode) {
      return NextResponse.json({ error: '2FA code required' }, { status: 400 })
    }

    const user = await one<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE id = $1`,
      [auth.id],
    )

    if (!user?.totp_secret) {
      return NextResponse.json({ error: '2FA not configured' }, { status: 400 })
    }

    const { decryptOrNull } = await import('@/lib/crypto')
    const { authenticator } = require('otplib') as { authenticator: { verify: (opts: { token: string; secret: string }) => boolean } }
    const secret = decryptOrNull(user.totp_secret)
    if (!secret) {
      return NextResponse.json({ error: 'Could not read 2FA secret' }, { status: 500 })
    }

    const valid = authenticator.verify({ token: totpCode, secret })
    if (!valid) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 400 })
    }

    const hash = await bcrypt.hash(newPassword, 11)
    await one(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, auth.id])
    return NextResponse.json({ ok: true })
  }

  // ── Copy-Paste defaults ───────────────────────────────────────
  // Fallback identity photo for reels that came from a profile scan rather
  // than a manual paste, which have no per-batch upload of their own.
  if (body.type === 'copy_paste') {
    const raw = (body as { default_reference_image_url?: string | null })
      .default_reference_image_url
    const url = typeof raw === 'string' ? raw.trim() : null
    if (url && !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'Reference photo must be an http(s) URL' }, { status: 400 })
    }
    await one(
      `UPDATE users SET default_reference_image_url = $1 WHERE id = $2`,
      [url || null, auth.id],
    )
    return NextResponse.json({ ok: true, default_reference_image_url: url || null })
  }

  // ── API keys update ───────────────────────────────────────────
  if (body.type === 'api_keys') {
    const updates: Record<string, string | null> = {}
    for (const field of KEY_FIELDS) {
      if (field in body) {
        const val = (body as Record<string, string>)[field]
        updates[field] = val ? encryptOrNull(val) : null
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: true })
    }

    const cols = Object.keys(updates)
    const setClauses = cols.map((col, i) => `${col} = $${i + 2}`).join(', ')
    const values = [auth.id, ...Object.values(updates)]

    await one(
      `INSERT INTO user_settings (user_id, ${cols.join(', ')}, updated_at)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, now())
       ON CONFLICT (user_id) DO UPDATE SET ${setClauses}, updated_at = now()`,
      values,
    )
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 })
}
