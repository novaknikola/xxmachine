import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const status = req.nextUrl.searchParams.get('status') ?? 'active'
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50'), 100)

  let where = `user_id = $1 AND admin_status = 'APPROVED'`
  const params: unknown[] = [auth.id]

  if (status === 'active') {
    where += ` AND replicate_status NOT IN ('done', 'skipped', 'failed', 'none')`
  } else if (status === 'done') {
    where += ` AND replicate_status = 'done'`
  } else if (status === 'failed') {
    where += ` AND replicate_status = 'failed'`
  } else if (status === 'pending') {
    where += ` AND replicate_status IN ('none', 'pending_classify', 'classified')`
  }

  params.push(limit)

  const items = await rows(
    `SELECT id, platform, profile, content_url, content_id, views, score,
            content_type, thumbnail_url, video_url, scene_prompt,
            generated_image_url, kling_video_url, replicate_status, replicate_error,
            admin_status, posted_at, discovered_at
       FROM discovery_items
      WHERE ${where}
      ORDER BY discovered_at DESC
      LIMIT $2`,
    params,
  )

  return NextResponse.json({ items })
}
