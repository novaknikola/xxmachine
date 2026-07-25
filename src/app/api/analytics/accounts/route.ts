import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, requireUser } from '@/lib/session'
import { rows, one, query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  try {
    const accounts = await rows(
      `SELECT id, platform, username, display_name, avatar_url, created_at
       FROM social_accounts
       ORDER BY platform, username`
    )
    return NextResponse.json(accounts)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  try {
    const { platform, username } = await req.json()
    if (!platform || !username) {
      return NextResponse.json({ error: 'platform and username required' }, { status: 400 })
    }
    if (!['twitter', 'tiktok'].includes(platform)) {
      return NextResponse.json({ error: 'platform must be twitter or tiktok' }, { status: 400 })
    }

    const clean = username.replace(/^@/, '').trim()
    const row = await one<{ id: string }>(
      `INSERT INTO social_accounts (platform, username)
       VALUES ($1, $2)
       ON CONFLICT (platform, username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [platform, clean]
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await query(`DELETE FROM social_accounts WHERE id=$1`, [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
