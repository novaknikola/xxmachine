import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET() {
  try {
    const pages = await rows<{
      id: string
      name: string
      page_id: string
      google_drive_folder_id: string | null
      published_count: number
      pending_count: number
      failed_count: number
    }>(
      `SELECT p.id, p.name, p.page_id, p.google_drive_folder_id,
              COALESCE(q.published_count, 0) AS published_count,
              COALESCE(q.pending_count, 0) AS pending_count,
              COALESCE(q.failed_count, 0) AS failed_count
       FROM facebook_pages p
       LEFT JOIN (
         SELECT page_id,
                COUNT(*) FILTER (WHERE status = 'done') AS published_count,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
         FROM facebook_queue
         GROUP BY page_id
       ) q ON q.page_id = p.id
       ORDER BY p.name`,
    )
    return NextResponse.json(pages)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, pageId, accessToken, googleDriveFolderId } = await req.json()
    if (!name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (!pageId?.trim()) return NextResponse.json({ error: 'Facebook Page ID required' }, { status: 400 })
    if (!accessToken?.trim()) return NextResponse.json({ error: 'Page access token required' }, { status: 400 })

    const row = await one<{ id: string }>(
      `INSERT INTO facebook_pages (name, page_id, access_token, google_drive_folder_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (page_id) DO UPDATE SET access_token = excluded.access_token
       RETURNING id`,
      [name.trim(), pageId.trim(), accessToken.trim(), googleDriveFolderId?.trim() || null],
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, name, accessToken, googleDriveFolderId } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(
      `UPDATE facebook_pages SET
        name = COALESCE(NULLIF($1, ''), name),
        access_token = COALESCE(NULLIF($2, ''), access_token),
        google_drive_folder_id = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE google_drive_folder_id END
       WHERE id=$4`,
      [name ?? '', accessToken ?? '', googleDriveFolderId ?? null, id],
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
