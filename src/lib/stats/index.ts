import { fetchInstagramStats } from './instagram'
import { fetchThreadsStats } from './threads'
import { fetchTwitterStats } from './twitter'
import { fetchTikTokStats } from './tiktok'

export async function fetchAllStats() {
  const [instagram, threads] = await Promise.all([
    fetchInstagramStats().catch(err => { console.error('[stats] instagram:', err); return [] }),
    fetchThreadsStats().catch(err => { console.error('[stats] threads:', err); return [] }),
  ])

  // Apify actors are sequential to avoid concurrent run cost
  await fetchTwitterStats().catch(err => console.error('[stats] twitter:', err))
  await fetchTikTokStats().catch(err => console.error('[stats] tiktok:', err))

  return { instagram, threads }
}
