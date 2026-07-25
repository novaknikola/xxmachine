import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const jobs = await rows(
    `SELECT id, job_type, status, total_items, done_items, progress,
            error, output, input, attempts, created_at, started_at, finished_at
       FROM generation_queue
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [user.id],
  )

  return NextResponse.json({ jobs })
}
