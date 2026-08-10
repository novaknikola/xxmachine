import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET() {
  try {
    const items = await rows(`
      SELECT q.id, q.drive_file_id, q.filename, q.scheduled_at, q.created_at,
             a.id AS account_id, a.name AS account_name, a.ig_username
      FROM instagram_queue q
      JOIN instagram_accounts a ON a.id = q.account_id
      WHERE q.status = 'pending_approval'
      ORDER BY q.scheduled_at ASC NULLS LAST
    `)
    return NextResponse.json(items)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { ids, action } = await req.json() as { ids?: string[]; action?: 'approve' | 'reject' }
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids required' }, { status: 400 })
    }
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 })
    }

    if (action === 'approve') {
      await one(
        `UPDATE instagram_queue SET status='pending'
         WHERE id = ANY($1::uuid[]) AND status='pending_approval'`,
        [ids],
      )
    } else {
      await one(
        `UPDATE instagram_queue SET status='failed', error_message='Rejected in Pending Approval review'
         WHERE id = ANY($1::uuid[]) AND status='pending_approval'`,
        [ids],
      )
    }

    return NextResponse.json({ ok: true, count: ids.length })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
