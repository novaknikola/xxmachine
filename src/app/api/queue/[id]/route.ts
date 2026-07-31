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

/** pause | resume | stop — My Pod queue controls (does not delete the row). */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  let body: { action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const action = body.action
  if (action !== 'pause' && action !== 'resume' && action !== 'stop') {
    return NextResponse.json({ error: 'action must be pause, resume, or stop' }, { status: 400 })
  }

  const job = await one<{ id: string; status: string }>(
    `SELECT id, status FROM generation_queue WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  if (action === 'pause') {
    if (job.status !== 'pending' && job.status !== 'processing') {
      return NextResponse.json({ error: 'Only waiting or processing jobs can be paused' }, { status: 409 })
    }
    const updated = await one(
      `UPDATE generation_queue
          SET status = 'paused',
              started_at = NULL,
              output = COALESCE(output, '{}'::jsonb)
                || jsonb_build_object('stage', 'paused')
        WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing')
        RETURNING id, status, done_items, progress`,
      [id, user.id],
    )
    if (!updated) return NextResponse.json({ error: 'Could not pause job' }, { status: 409 })
    return NextResponse.json({ ok: true, job: updated })
  }

  if (action === 'resume') {
    if (job.status !== 'paused' && job.status !== 'failed' && job.status !== 'cancelled') {
      return NextResponse.json({ error: 'Only paused, failed, or cancelled jobs can be started' }, { status: 409 })
    }
    const updated = await one(
      `UPDATE generation_queue
          SET status = 'pending',
              started_at = NULL,
              finished_at = NULL,
              error = NULL,
              output = CASE
                WHEN output IS NULL THEN jsonb_build_object('stage', 'queued')
                ELSE (output - 'progressAt') || jsonb_build_object('stage', 'queued')
              END
        WHERE id = $1 AND user_id = $2 AND status IN ('paused', 'failed', 'cancelled')
        RETURNING id, status, done_items, progress`,
      [id, user.id],
    )
    if (!updated) return NextResponse.json({ error: 'Could not resume job' }, { status: 409 })
    return NextResponse.json({ ok: true, job: updated })
  }

  // stop — cancel but keep in queue (unlike DELETE which removes the row)
  if (job.status !== 'pending' && job.status !== 'processing' && job.status !== 'paused') {
    return NextResponse.json({ error: 'Only active or paused jobs can be stopped' }, { status: 409 })
  }
  const updated = await one(
    `UPDATE generation_queue
        SET status = 'cancelled',
            finished_at = now(),
            started_at = NULL,
            output = COALESCE(output, '{}'::jsonb)
              || jsonb_build_object('stage', 'stopped')
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing', 'paused')
      RETURNING id, status, done_items, progress`,
    [id, user.id],
  )
  if (!updated) return NextResponse.json({ error: 'Could not stop job' }, { status: 409 })
  return NextResponse.json({ ok: true, job: updated })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const { id } = await params

  // Soft-cancel first so an in-flight worker stops between items, then remove from queue.
  await query(
    `UPDATE generation_queue
        SET status = 'cancelled', finished_at = COALESCE(finished_at, now())
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing', 'paused')`,
    [id, user.id],
  )

  const result = await query(
    `DELETE FROM generation_queue WHERE id = $1 AND user_id = $2`,
    [id, user.id],
  )

  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
