import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows, one, query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { searchParams } = new URL(req.url)
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '30'), 100)
  const offset = parseInt(searchParams.get('offset') ?? '0')

  const data = await rows(
    `select pj.*, di.content_url as source_content_url, di.profile as source_profile
       from pipeline_jobs pj
       left join discovery_items di on di.id = pj.discovery_item_id
      where pj.user_id = $1
      order by pj.created_at desc
      limit $2 offset $3`,
    [user.id, limit, offset],
  )
  return NextResponse.json({ jobs: data })
}

// Create a pipeline job manually (for direct URL submission)
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { source_url, motion_notes, discovery_item_id } = await req.json()
  if (!source_url) return NextResponse.json({ error: 'source_url required' }, { status: 400 })

  const row = await one(
    `insert into pipeline_jobs (user_id, source_url, motion_notes, discovery_item_id)
     values ($1,$2,$3,$4)
     returning *`,
    [user.id, source_url, motion_notes ?? null, discovery_item_id ?? null],
  )

  if (discovery_item_id) {
    await query(
      `update discovery_items set pipeline_job_id = $2 where id = $1 and user_id = $3`,
      [discovery_item_id, (row as Record<string, unknown>)?.id, user.id],
    )
  }

  return NextResponse.json({ job: row })
}
