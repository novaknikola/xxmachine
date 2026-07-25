import { rows, query } from '@/lib/db'

const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'apidojo~tweet-scraper'

interface SocialAccount {
  id: string
  username: string
}

interface ApifyTwitterUser {
  userName?: string
  name?: string
  followers?: number
  following?: number
  statusesCount?: number
  profilePicture?: string
}

async function runApifyActor(input: object): Promise<ApifyTwitterUser[]> {
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

export async function fetchTwitterStats() {
  if (!APIFY_TOKEN) return []

  const accounts = await rows<SocialAccount>(
    `SELECT id, username FROM social_accounts WHERE platform='twitter'`
  )
  if (accounts.length === 0) return []

  for (const account of accounts) {
    try {
      const items = await runApifyActor({
        startUrls: [{ url: `https://twitter.com/${account.username}` }],
        maxItems: 1,
        onlyUserInfo: true,
      })

      const user: ApifyTwitterUser = items[0] ?? {}

      await query(
        `INSERT INTO platform_stats
           (platform, account_id, account_name, followers, following, posts_count, raw)
         VALUES ('twitter', $1, $2, $3, $4, $5, $6)`,
        [account.id, user.userName ?? account.username, user.followers ?? null, user.following ?? null, user.statusesCount ?? null, JSON.stringify(user)]
      )

      // Update display name and avatar if we got them
      if (user.name || user.profilePicture) {
        await query(
          `UPDATE social_accounts SET display_name=COALESCE($1, display_name), avatar_url=COALESCE($2, avatar_url) WHERE id=$3`,
          [user.name ?? null, user.profilePicture ?? null, account.id]
        )
      }
    } catch (err) {
      console.error(`[stats/twitter] @${account.username}:`, err)
      await query(
        `INSERT INTO platform_stats (platform, account_id, account_name, raw)
         VALUES ('twitter', $1, $2, $3)`,
        [account.id, account.username, JSON.stringify({ error: String(err) })]
      )
    }
  }
}
