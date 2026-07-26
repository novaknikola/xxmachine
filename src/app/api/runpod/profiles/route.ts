import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { query, rows, one } from '@/lib/db'

/** Accepts @user, bare handle, or full instagram.com URL. */
function normalizeIgUsername(raw: string): string {
  let s = raw.trim()
  try {
    if (s.includes('instagram.com')) {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`)
      s = u.pathname.split('/').filter(Boolean)[0] ?? ''
    }
  } catch {
    /* keep raw */
  }
  return s.replace(/^@/, '').replace(/\/+$/, '').split('?')[0]?.trim() ?? ''
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const data = await rows(
    `select * from tracked_profiles where user_id = $1 order by created_at desc`,
    [user.id],
  )
  return NextResponse.json({ profiles: data })
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { platform, username, min_score, max_age_days, autopilot, autopilot_min_score, character_id } = await req.json()
  if (!platform || !username) return NextResponse.json({ error: 'platform and username required' }, { status: 400 })

  const handle = normalizeIgUsername(String(username))
  if (!handle) return NextResponse.json({ error: 'Invalid Instagram username' }, { status: 400 })

  const row = await one(
    `insert into tracked_profiles
       (user_id, platform, username, min_score, max_age_days, autopilot, autopilot_min_score, character_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (user_id, platform, username) do update
       set min_score = excluded.min_score,
           max_age_days = excluded.max_age_days,
           autopilot = excluded.autopilot,
           autopilot_min_score = excluded.autopilot_min_score,
           character_id = coalesce(excluded.character_id, tracked_profiles.character_id),
           status = 'ACTIVE'
     returning *`,
    [user.id, platform, handle, min_score ?? 10, max_age_days ?? 14, autopilot ?? false, autopilot_min_score ?? 25, character_id ?? null],
  )
  return NextResponse.json({ profile: row })
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { id, ...fields } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const allowed = ['status', 'autopilot', 'autopilot_min_score', 'min_score', 'max_age_days', 'character_id']
  const sets: string[] = []
  const params: unknown[] = [user.id, id]

  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      params.push(v)
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (sets.length === 0) return NextResponse.json({ error: 'no valid fields' }, { status: 400 })

  await query(
    `update tracked_profiles set ${sets.join(', ')} where user_id = $1 and id = $2`,
    params,
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { id } = await req.json()
  await query(`delete from tracked_profiles where user_id = $1 and id = $2`, [user.id, id])
  return NextResponse.json({ ok: true })
}
