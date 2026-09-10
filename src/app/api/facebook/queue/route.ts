import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const pageId = req.nextUrl.searchParams.get('pageId')
    if (!pageId) return NextResponse.json({ error: 'pageId required' }, { status: 400 })
    const category = req.nextUrl.searchParams.get('category') // null = all

    const items = await rows(
      `SELECT id, drive_file_id, filename, status, caption, category, thumbnail_url, scheduled_at, published_at, facebook_video_id, error_message, created_at
       FROM facebook_queue
       WHERE page_id=$1 ${category ? 'AND category=$2' : ''}
       ORDER BY scheduled_at ASC NULLS LAST, created_at ASC`,
      category ? [pageId, category] : [pageId],
    )

    const categories = await rows<{ category: string }>(
      `SELECT DISTINCT category FROM facebook_queue WHERE page_id=$1 AND category IS NOT NULL ORDER BY category`,
      [pageId],
    )

    return NextResponse.json({ items, categories: categories.map(r => r.category) })
  } catch (err) {
    console.error('[facebook/queue GET]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { pageId, items, category } = await req.json()
    if (!pageId || !Array.isArray(items)) {
      return NextResponse.json({ error: 'pageId and items required' }, { status: 400 })
    }

    let inserted = 0
    for (const item of items) {
      const row = await one(
        `INSERT INTO facebook_queue (page_id, drive_file_id, filename, caption, scheduled_at, category)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [pageId, item.driveFileId, item.filename, item.caption ?? '', item.scheduledAt ?? null, category ?? item.category ?? null],
      )
      if (row) inserted++
    }

    return NextResponse.json({ inserted })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, caption, scheduledAt, category } = await req.json()
    await one(
      `UPDATE facebook_queue SET
        caption = COALESCE($1, caption),
        scheduled_at = COALESCE($2, scheduled_at),
        category = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE category END
       WHERE id=$4`,
      [caption ?? null, scheduledAt ?? null, category ?? null, id],
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()

    // Bulk delete: { pageId, category?, statusFilter? }
    if (body.pageId) {
      const { pageId, category, statusFilter } = body
      const statuses = statusFilter ?? ['pending']
      const placeholders = statuses.map((_: string, i: number) => `$${i + 2}`).join(',')
      const params: unknown[] = [pageId, ...statuses]

      if (category) {
        params.push(category)
        await one(
          `DELETE FROM facebook_queue WHERE page_id=$1 AND status IN (${placeholders}) AND category=$${params.length}`,
          params,
        )
      } else {
        await one(
          `DELETE FROM facebook_queue WHERE page_id=$1 AND status IN (${placeholders})`,
          params,
        )
      }
      return NextResponse.json({ ok: true })
    }

    // Bulk delete by explicit ids: { ids: string[] }
    if (Array.isArray(body.ids)) {
      const placeholders = body.ids.map((_: string, i: number) => `$${i + 1}`).join(',')
      await one(`DELETE FROM facebook_queue WHERE id IN (${placeholders}) AND status='pending'`, body.ids)
      return NextResponse.json({ ok: true })
    }

    // Single delete: { id }
    await one(`DELETE FROM facebook_queue WHERE id=$1 AND status='pending'`, [body.id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
