import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { searchParams } = new URL(req.url)
  const account_id = searchParams.get('account_id')
  const platform = searchParams.get('platform')
  const days = Math.min(parseInt(searchParams.get('days') ?? '30'), 90)

  if (!account_id || !platform) {
    return NextResponse.json({ error: 'account_id and platform required' }, { status: 400 })
  }

  try {
    const data = await rows<{ fetched_at: string; followers: number | null; views_30d: number | null }>(
      `SELECT fetched_at, followers, views_30d
       FROM platform_stats
       WHERE platform = $1
         AND account_id = $2
         AND fetched_at >= now() - ($3 || ' days')::interval
       ORDER BY fetched_at ASC`,
      [platform, account_id, days]
    )
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
