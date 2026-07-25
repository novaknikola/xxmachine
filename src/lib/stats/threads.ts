import { rows, query } from '@/lib/db'

interface ThreadsAccount {
  id: string
  name: string
  threads_username: string | null
  threads_user_id: string | null
  access_token: string | null
  token_expires_at: string | null
}

interface StatRow {
  account_id: string
  account_name: string
  followers: number | null
  posts_count: number | null
  views_30d: number | null
  raw: object
  error?: string
}

async function thGet(path: string, token: string) {
  const res = await fetch(`https://graph.threads.net/v1.0${path}&access_token=${token}`)
  return res.json()
}

export async function fetchThreadsStats(): Promise<StatRow[]> {
  const accounts = await rows<ThreadsAccount>(
    `SELECT id, name, threads_username, threads_user_id, access_token, token_expires_at
     FROM threads_accounts
     WHERE access_token IS NOT NULL`
  )

  const results: StatRow[] = []

  for (const account of accounts) {
    const token = account.access_token!
    try {
      const me = await thGet('/me?fields=id,username,followers_count,threads_count', token)
      if (me.error) throw new Error(me.error.message)

      const userId: string = me.id
      const followers: number | null = me.followers_count ?? null
      const posts_count: number | null = me.threads_count ?? null

      // Threads insights: views for the last 30 days
      let views_30d: number | null = null
      const insights = await thGet(
        `/${userId}/threads_insights?metric=views&period=days_30`,
        token
      )
      if (!insights.error && insights.data) {
        const viewEntry = insights.data.find((d: { name: string }) => d.name === 'views')
        views_30d = viewEntry?.total_value?.value ?? null
      }

      results.push({
        account_id: account.id,
        account_name: me.username ?? account.threads_username ?? account.name,
        followers,
        posts_count,
        views_30d,
        raw: me,
      })
    } catch (err) {
      results.push({
        account_id: account.id,
        account_name: account.threads_username ?? account.name,
        followers: null,
        posts_count: null,
        views_30d: null,
        raw: {},
        error: String(err),
      })
    }
  }

  for (const r of results) {
    await query(
      `INSERT INTO platform_stats
         (platform, account_id, account_name, followers, posts_count, views_30d, raw)
       VALUES ('threads', $1, $2, $3, $4, $5, $6)`,
      [r.account_id, r.account_name, r.followers, r.posts_count, r.views_30d, JSON.stringify(r.raw)]
    )
  }

  return results
}
