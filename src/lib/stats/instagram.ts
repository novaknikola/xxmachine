import { rows, query } from '@/lib/db'

interface InstagramAccount {
  id: string
  name: string
  ig_access_token: string | null
  ig_token_expires_at: string | null
}

interface StatRow {
  account_id: string
  account_name: string
  followers: number | null
  posts_count: number | null
  views_30d: number | null
  reach_30d: number | null
  impressions_30d: number | null
  raw: object
  error?: string
}

async function igGet(path: string, token: string) {
  const res = await fetch(`https://graph.instagram.com/v22.0${path}&access_token=${token}`)
  return res.json()
}

export async function fetchInstagramStats(): Promise<StatRow[]> {
  const accounts = await rows<InstagramAccount>(
    `SELECT id, name, ig_access_token, ig_token_expires_at
     FROM instagram_accounts
     WHERE ig_access_token IS NOT NULL`
  )

  const results: StatRow[] = []

  for (const account of accounts) {
    const token = account.ig_access_token!
    try {
      // Get user ID and basic profile
      const me = await igGet('/me?fields=id,username,followers_count,media_count', token)
      if (me.error) throw new Error(me.error.message)

      const igUserId: string = me.id
      const followers: number = me.followers_count ?? null
      const posts_count: number = me.media_count ?? null

      // Get 30-day insights (requires business/creator account)
      let views_30d: number | null = null
      let reach_30d: number | null = null
      let impressions_30d: number | null = null

      const insights = await igGet(
        `/${igUserId}/insights?metric=impressions,reach,profile_views&period=days_28&metric_type=total_value`,
        token
      )

      if (!insights.error && insights.data) {
        for (const item of insights.data) {
          const val: number = item.total_value?.value ?? null
          if (item.name === 'profile_views') views_30d = val
          if (item.name === 'reach') reach_30d = val
          if (item.name === 'impressions') impressions_30d = val
        }
      }

      results.push({
        account_id: account.id,
        account_name: me.username ?? account.name,
        followers,
        posts_count,
        views_30d,
        reach_30d,
        impressions_30d,
        raw: me,
      })
    } catch (err) {
      results.push({
        account_id: account.id,
        account_name: account.name,
        followers: null,
        posts_count: null,
        views_30d: null,
        reach_30d: null,
        impressions_30d: null,
        raw: {},
        error: String(err),
      })
    }
  }

  if (results.length === 0) return results

  for (const r of results) {
    await query(
      `INSERT INTO platform_stats
         (platform, account_id, account_name, followers, posts_count, views_30d, reach_30d, impressions_30d, raw)
       VALUES ('instagram', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.account_id, r.account_name, r.followers, r.posts_count, r.views_30d, r.reach_30d, r.impressions_30d, JSON.stringify(r.raw)]
    )
  }

  return results
}
