import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'

type RouteParams = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  const job = await one(
    `SELECT id, job_type, status, total_items, done_items, progress,
            error, output, attempts, created_at, started_at, finished_at
       FROM generation_queue
      WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ job })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  const result = await query(
    `UPDATE generation_queue
        SET status = 'cancelled', finished_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [id, user.id],
  )

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Job not found or not cancellable' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
