import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get('accountId')
    if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    const category = req.nextUrl.searchParams.get('category') // null = all

    const items = await rows(
      `SELECT id, drive_file_id, filename, status, caption, category, scheduled_at, published_at, instagram_media_id, error_message, created_at
       FROM instagram_queue
       WHERE account_id=$1 ${category ? 'AND category=$2' : ''}
       ORDER BY scheduled_at ASC NULLS LAST, created_at ASC`,
      category ? [accountId, category] : [accountId]
    )

    const categories = await rows<{ category: string }>(
      `SELECT DISTINCT category FROM instagram_queue WHERE account_id=$1 AND category IS NOT NULL ORDER BY category`,
      [accountId]
    )

    return NextResponse.json({ items, categories: categories.map(r => r.category) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { accountId, items, category } = await req.json()
    if (!accountId || !Array.isArray(items)) {
      return NextResponse.json({ error: 'accountId and items required' }, { status: 400 })
    }

    let inserted = 0
    for (const item of items) {
      const row = await one(
        `INSERT INTO instagram_queue (account_id, drive_file_id, filename, caption, scheduled_at, category)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [accountId, item.driveFileId, item.filename, item.caption ?? '', item.scheduledAt ?? null, category ?? item.category ?? null]
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
      `UPDATE instagram_queue SET
        caption = COALESCE($1, caption),
        scheduled_at = COALESCE($2, scheduled_at),
        category = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE category END
       WHERE id=$4`,
      [caption ?? null, scheduledAt ?? null, category ?? null, id]
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()

    // Bulk delete: { accountId, category?, statusFilter? }
    if (body.accountId) {
      const { accountId, category, statusFilter } = body
      const statuses = statusFilter ?? ['pending']
      const placeholders = statuses.map((_: string, i: number) => `$${i + 2}`).join(',')
      const params: unknown[] = [accountId, ...statuses]

      if (category) {
        params.push(category)
        await one(
          `DELETE FROM instagram_queue WHERE account_id=$1 AND status IN (${placeholders}) AND category=$${params.length}`,
          params
        )
      } else {
        await one(
          `DELETE FROM instagram_queue WHERE account_id=$1 AND status IN (${placeholders})`,
          params
        )
      }
      return NextResponse.json({ ok: true })
    }

    // Single delete: { id }
    await one(`DELETE FROM instagram_queue WHERE id=$1 AND status='pending'`, [body.id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
