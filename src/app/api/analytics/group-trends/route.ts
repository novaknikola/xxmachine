import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

interface DailyRow {
  day: string
  platform: string
  account_id: string
  account_name: string
  followers: number | null
  views_30d: number | null
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { searchParams } = new URL(req.url)
  const days = Math.min(parseInt(searchParams.get('days') ?? '30'), 90)

  try {
    // One row per account per day (latest snapshot of that day)
    const data = await rows<DailyRow>(
      `SELECT DISTINCT ON (day, platform, account_id)
         date_trunc('day', fetched_at)::date::text AS day,
         platform,
         account_id,
         account_name,
         followers,
         views_30d
       FROM platform_stats
       WHERE fetched_at >= now() - ($1 || ' days')::interval
       ORDER BY day, platform, account_id, fetched_at DESC`,
      [days]
    )

    // Group by account
    const accountMap = new Map<string, {
      account_id: string
      account_name: string
      platform: string
      data: { day: string; followers: number | null; views_30d: number | null }[]
    }>()

    for (const row of data) {
      const key = `${row.platform}:${row.account_id}`
      if (!accountMap.has(key)) {
        accountMap.set(key, {
          account_id: row.account_id,
          account_name: row.account_name,
          platform: row.platform,
          data: [],
        })
      }
      accountMap.get(key)!.data.push({ day: row.day, followers: row.followers, views_30d: row.views_30d })
    }

    // Aggregate totals by day across all accounts
    const totalsByDay = new Map<string, { followers: number; views_30d: number }>()
    for (const row of data) {
      const existing = totalsByDay.get(row.day) ?? { followers: 0, views_30d: 0 }
      totalsByDay.set(row.day, {
        followers: existing.followers + (row.followers ?? 0),
        views_30d: existing.views_30d + (row.views_30d ?? 0),
      })
    }

    const totals = Array.from(totalsByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v }))

    return NextResponse.json({
      byAccount: Array.from(accountMap.values()),
      totals,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
