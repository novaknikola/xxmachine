import { rows, query } from '@/lib/db'

const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'clockworks~tiktok-scraper'

interface SocialAccount {
  id: string
  username: string
}

interface ApifyTikTokUser {
  authorMeta?: {
    name?: string
    nickName?: string
    fans?: number
    following?: number
    video?: number
    heart?: number
    avatar?: string
  }
  // Some actors return flat structure
  name?: string
  fans?: number
  following?: number
  video?: number
  heart?: number
  avatar?: string
}

async function runApifyActor(input: object): Promise<ApifyTikTokUser[]> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  )
  const startData = await startRes.json()
  const runId: string = startData?.data?.id
  if (!runId) throw new Error('Apify run failed to start: ' + JSON.stringify(startData))

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)
    const statusData = await statusRes.json()
    const status: string = statusData?.data?.status
    if (status === 'SUCCEEDED') break
    if (status === 'FAILED' || status === 'ABORTED') throw new Error('Apify run failed: ' + status)
  }

  const dataRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&format=json`
  )
  return dataRes.json()
}

export async function fetchTikTokStats() {
  if (!APIFY_TOKEN) return []

  const accounts = await rows<SocialAccount>(
    `SELECT id, username FROM social_accounts WHERE platform='tiktok'`
  )
  if (accounts.length === 0) return []

  for (const account of accounts) {
    try {
      const items = await runApifyActor({
        profiles: [`https://www.tiktok.com/@${account.username}`],
        resultsType: 'users',
        resultsPerPage: 1,
      })

      const raw: ApifyTikTokUser = items[0] ?? {}
      // Normalize — actor may return nested authorMeta or flat fields
      const nested = raw.authorMeta
      const followers: number | null = nested?.fans ?? raw.fans ?? null
      const following: number | null = nested?.following ?? raw.following ?? null
      const posts_count: number | null = nested?.video ?? raw.video ?? null
      const likes_total: number | null = nested?.heart ?? raw.heart ?? null
      const displayName: string | null = nested?.nickName ?? nested?.name ?? raw.name ?? null
      const avatar: string | null = nested?.avatar ?? raw.avatar ?? null

      await query(
        `INSERT INTO platform_stats
           (platform, account_id, account_name, followers, following, posts_count, likes_total, raw)
         VALUES ('tiktok', $1, $2, $3, $4, $5, $6, $7)`,
        [account.id, account.username, followers, following, posts_count, likes_total, JSON.stringify(raw)]
      )

      if (displayName || avatar) {
        await query(
          `UPDATE social_accounts SET display_name=COALESCE($1, display_name), avatar_url=COALESCE($2, avatar_url) WHERE id=$3`,
          [displayName, avatar, account.id]
        )
      }
    } catch (err) {
      console.error(`[stats/tiktok] @${account.username}:`, err)
      await query(
        `INSERT INTO platform_stats (platform, account_id, account_name, raw)
         VALUES ('tiktok', $1, $2, $3)`,
        [account.id, account.username, JSON.stringify({ error: String(err) })]
      )
    }
  }
}
