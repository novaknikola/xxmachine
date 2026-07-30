import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const jobs = await rows(
    `SELECT g.id, g.job_type, g.status, g.total_items, g.done_items, g.progress,
            g.error, g.output, g.input, g.attempts, g.created_at, g.started_at, g.finished_at,
            g.pod_session_id,
            ps.name AS pod_name
       FROM generation_queue g
       LEFT JOIN pod_sessions ps ON ps.id = g.pod_session_id
      WHERE g.user_id = $1
      ORDER BY g.created_at DESC
      LIMIT 50`,
    [user.id],
  )

  return NextResponse.json({ jobs })
}
