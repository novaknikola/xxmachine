import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { requireApiToken } from '@/lib/api-token'

interface JobRow {
  status: string
  total_items: number
  done_items: number
  output: { urls?: string[] } | null
  error: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Variant i of the job is urls[i]. A variant that failed to render stays in
 * the list as "error:<reason>" so indexes keep matching the devices they were
 * ordered for.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const job = await one<JobRow>(
    `SELECT status, total_items, done_items, output, error
       FROM generation_queue
      WHERE id = $1 AND user_id = $2 AND job_type = 'video_repurpose'`,
    [id, auth.id],
  )
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({
    status: job.status,
    total: job.total_items,
    done: job.done_items,
    urls: job.output?.urls ?? [],
    error: job.error,
  })
}
