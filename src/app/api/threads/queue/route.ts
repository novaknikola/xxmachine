import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get('accountId')
    if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

    const items = await rows(
      `SELECT id, content, media_url, media_type, status, threads_media_id,
              error_message, scheduled_at, published_at, created_at
       FROM threads_queue
       WHERE account_id=$1
       ORDER BY scheduled_at ASC NULLS LAST, created_at ASC`,
      [accountId]
    )
    return NextResponse.json({ items })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { accountId, content, mediaUrl, mediaType, scheduledAt } = await req.json()
    if (!accountId || !content) {
      return NextResponse.json({ error: 'accountId and content required' }, { status: 400 })
    }
    const row = await one<{ id: string }>(
      `INSERT INTO threads_queue (account_id, content, media_url, media_type, scheduled_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [accountId, content, mediaUrl ?? null, mediaType ?? 'TEXT', scheduledAt ?? null]
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, content, mediaUrl, scheduledAt } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(
      `UPDATE threads_queue SET
        content = COALESCE($1, content),
        media_url = COALESCE($2, media_url),
        scheduled_at = COALESCE($3, scheduled_at)
       WHERE id=$4`,
      [content ?? null, mediaUrl ?? null, scheduledAt ?? null, id]
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()

    // Bulk delete: { accountId, statusFilter? }
    if (body.accountId) {
      const { accountId, statusFilter } = body
      const statuses: string[] = statusFilter ?? ['pending']
      const placeholders = statuses.map((_: string, i: number) => `$${i + 2}`).join(',')
      await one(
        `DELETE FROM threads_queue WHERE account_id=$1 AND status IN (${placeholders})`,
        [accountId, ...statuses]
      )
      return NextResponse.json({ ok: true })
    }

    // Single delete: { id }
    if (!body.id) return NextResponse.json({ error: 'id or accountId required' }, { status: 400 })
    await one(`DELETE FROM threads_queue WHERE id=$1`, [body.id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
