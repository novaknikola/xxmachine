import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { WINDOWS, randomTimeInWindow } from '@/lib/instagram/auto-schedule'

/**
 * Assigns scheduled_at to a batch of pending facebook_queue items in one
 * shot: fills the same morning/afternoon/evening windows the daily
 * auto-schedule uses, one item per window, walking forward day by day
 * starting at startDate — so a 21-item mass-schedule spans exactly 7 days.
 */
export async function POST(req: NextRequest) {
  try {
    const { ids, startDate } = await req.json()
    if (!Array.isArray(ids) || !ids.length) {
      return NextResponse.json({ error: 'ids required' }, { status: 400 })
    }
    const day0 = startDate ? new Date(`${startDate}T00:00:00`) : new Date()

    for (let i = 0; i < ids.length; i++) {
      const dayOffset = Math.floor(i / WINDOWS.length)
      const window = WINDOWS[i % WINDOWS.length]
      const day = new Date(day0)
      day.setDate(day.getDate() + dayOffset)
      const scheduledAt = randomTimeInWindow(day, window)

      await query(
        `UPDATE facebook_queue SET scheduled_at=$1 WHERE id=$2 AND status='pending'`,
        [scheduledAt.toISOString(), ids[i]],
      )
    }

    return NextResponse.json({ scheduled: ids.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
