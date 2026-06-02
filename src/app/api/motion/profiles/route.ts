import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import type { TrackedProfile } from '@/lib/types'

export async function GET() {
  const profiles = await rows<TrackedProfile>(
    'SELECT id, username, active, created_at FROM tracked_profiles ORDER BY created_at DESC'
  )
  return NextResponse.json({ profiles })
}

export async function POST(req: NextRequest) {
  const { username } = await req.json()
  if (!username || typeof username !== 'string') {
    return NextResponse.json({ error: 'Missing username' }, { status: 400 })
  }
  const clean = username.trim().replace(/^@/, '').toLowerCase()
  try {
    const result = await query<TrackedProfile>(
      'INSERT INTO tracked_profiles (username) VALUES ($1) ON CONFLICT (username) DO UPDATE SET active = TRUE RETURNING *',
      [clean]
    )
    return NextResponse.json({ profile: result.rows[0] })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'DB error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const { username } = await req.json()
  if (!username) return NextResponse.json({ error: 'Missing username' }, { status: 400 })
  await query('UPDATE tracked_profiles SET active = FALSE WHERE username = $1', [username])
  return NextResponse.json({ ok: true })
}
