import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { query, rows, one } from '@/lib/db'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { searchParams } = new URL(req.url)
  const status   = searchParams.get('status') ?? 'PENDING'
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)
  const offset   = parseInt(searchParams.get('offset') ?? '0')

  const data = await rows<{ score: string | number }>(
    `select * from discovery_items
      where user_id = $1 and admin_status = $2
      order by score desc, discovered_at desc
      limit $3 offset $4`,
    [user.id, status, limit, offset],
  )
  // `score` is a Postgres `numeric` column; node-postgres returns those as
  // strings (not JS numbers) to avoid precision loss, which crashes any
  // caller doing `item.score.toFixed(...)`.
  const items = data.map(row => ({ ...row, score: Number(row.score) }))
  return NextResponse.json({ items })
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { id, admin_status, notes } = await req.json()
  if (!id || !admin_status) return NextResponse.json({ error: 'id and admin_status required' }, { status: 400 })

  const row = await one(
    `update discovery_items
        set admin_status = $3,
            notes = coalesce($4, notes),
            replicate_status = case
              when $3 = 'APPROVED' and replicate_status = 'none' then 'pending_classify'
              else replicate_status
            end
      where user_id = $1 and id = $2
      returning *`,
    [user.id, id, admin_status, notes ?? null],
  )
  return NextResponse.json({ item: row })
}

// Batch approve/reject
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { ids, admin_status } = await req.json()
  if (!ids?.length || !admin_status) return NextResponse.json({ error: 'ids[] and admin_status required' }, { status: 400 })

  await query(
    `update discovery_items set admin_status = $3
      where user_id = $1 and id = any($2::uuid[])`,
    [user.id, ids, admin_status],
  )
  return NextResponse.json({ ok: true, updated: ids.length })
}
