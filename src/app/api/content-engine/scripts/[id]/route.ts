import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'

type RouteParams = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  const item = await one(
    `SELECT id, topic, script, created_at, updated_at
       FROM content_engine_scripts
      WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ item })
}

/** Hand-edit a generated script's content (e.g. after tweaking a line). */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  let body: { script?: unknown; topic?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.script === undefined && body.topic === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const item = await one(
    `UPDATE content_engine_scripts
        SET script = COALESCE($1, script),
            topic = COALESCE($2, topic),
            updated_at = now()
      WHERE id = $3 AND user_id = $4
      RETURNING id, topic, script, created_at, updated_at`,
    [body.script !== undefined ? JSON.stringify(body.script) : null, body.topic ?? null, id, user.id],
  )
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ item })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  const result = await query(`DELETE FROM content_engine_scripts WHERE id = $1 AND user_id = $2`, [id, user.id])
  if (!result.rowCount) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
