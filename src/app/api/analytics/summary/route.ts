import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

export interface StatSnapshot {
  id: string
  platform: 'instagram' | 'threads' | 'twitter' | 'tiktok'
  account_id: string
  account_name: string
  followers: number | null
  following: number | null
  posts_count: number | null
  views_30d: number | null
  reach_30d: number | null
  impressions_30d: number | null
  likes_total: number | null
  fetched_at: string
  has_error: boolean
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  try {
    const stats = await rows<StatSnapshot>(`
      SELECT DISTINCT ON (platform, account_id)
        id, platform, account_id, account_name,
        followers, following, posts_count,
        views_30d, reach_30d, impressions_30d, likes_total,
        fetched_at,
        (raw->>'error' IS NOT NULL) AS has_error
      FROM platform_stats
      ORDER BY platform, account_id, fetched_at DESC
    `)

    const byPlatform = {
      instagram: stats.filter(s => s.platform === 'instagram'),
      threads: stats.filter(s => s.platform === 'threads'),
      twitter: stats.filter(s => s.platform === 'twitter'),
      tiktok: stats.filter(s => s.platform === 'tiktok'),
    }

    const totalAccounts = stats.length
    const totalFollowers = stats.reduce((sum, s) => sum + (s.followers ?? 0), 0)
    const totalViews30d = stats.reduce((sum, s) => sum + (s.views_30d ?? 0), 0)
    const lastFetchedAt = stats.length > 0
      ? stats.reduce((latest, s) => s.fetched_at > latest ? s.fetched_at : latest, stats[0].fetched_at)
      : null

    return NextResponse.json({
      stats: byPlatform,
      totals: { totalAccounts, totalFollowers, totalViews30d, lastFetchedAt },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
