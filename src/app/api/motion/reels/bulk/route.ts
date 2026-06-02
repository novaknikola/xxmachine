import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

type Action = 'approve' | 'archive' | 'delete' | 'restore'

export async function POST(req: NextRequest) {
  try {
    const { ids, action } = await req.json() as { ids: number[]; action: Action }
    if (!ids?.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')

    if (action === 'approve') {
      await query(`UPDATE viral_reels SET status = 'approved' WHERE id IN (${placeholders})`, ids)
    } else if (action === 'archive') {
      await query(`UPDATE viral_reels SET status = 'archived' WHERE id IN (${placeholders})`, ids)
    } else if (action === 'restore') {
      await query(`UPDATE viral_reels SET status = 'viral_detected' WHERE id IN (${placeholders})`, ids)
    } else if (action === 'delete') {
      await query(`DELETE FROM viral_reels WHERE id IN (${placeholders})`, ids)
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ ok: true, affected: ids.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
