import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { generateToken, hashToken } from '@/lib/api-token'

/** Whether a token exists, and when it was made/last used — never the value itself. */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const row = await one<{ created_at: string; last_used_at: string | null }>(
    `select created_at, last_used_at from personal_access_tokens where user_id = $1`,
    [auth.id],
  )
  return NextResponse.json({ isSet: !!row, createdAt: row?.created_at ?? null, lastUsedAt: row?.last_used_at ?? null })
}

/**
 * Generate a new extension token, replacing any existing one — a user only
 * ever has one browser to pair, and rotating is simpler than managing a list.
 * The raw value is returned once and never stored.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const token = generateToken()
  await query(`delete from personal_access_tokens where user_id = $1`, [auth.id])
  await query(
    `insert into personal_access_tokens (user_id, token_hash, label) values ($1, $2, 'Browser extension')`,
    [auth.id, hashToken(token)],
  )
  return NextResponse.json({ token })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  await query(`delete from personal_access_tokens where user_id = $1`, [auth.id])
  return NextResponse.json({ ok: true })
}
