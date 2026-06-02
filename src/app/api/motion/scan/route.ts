import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import type { TrackedProfile } from '@/lib/types'

const APIFY_TOKEN = process.env.APIFY_API_KEY!
const ACTOR_ID = 'apify~instagram-reel-scraper'

interface ApifyReel {
  shortCode?: string
  url?: string
  displayUrl?: string
  images?: string[]
  videoUrl?: string
  videoViewCount?: number
  videoPlayCount?: number
  playCount?: number
  timestamp?: string
  ownerUsername?: string
}

async function runApifyActorForUser(username: string): Promise<ApifyReel[]> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: [username], resultsLimit: 30 }),
    }
  )
  const startData = await startRes.json()
  const runId: string = startData?.data?.id
  if (!runId) throw new Error('Apify run failed to start: ' + JSON.stringify(startData))

  for (let i = 0; i < 36; i++) {
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

export async function POST(req: NextRequest) {
  if (!APIFY_TOKEN) {
    return NextResponse.json({ error: 'APIFY_API_KEY not configured' }, { status: 500 })
  }

  // Configurable thresholds from request body
  const body = await req.json().catch(() => ({}))
  const minViews: number = body.minViews ?? 10_000
  const daysBack: number = body.daysBack ?? 30

  const profiles = await rows<TrackedProfile>('SELECT username FROM tracked_profiles WHERE active = TRUE')
  if (profiles.length === 0) {
    return NextResponse.json({ message: 'No active profiles to scan', added: 0 })
  }

  const usernames = profiles.map(p => p.username)
  const debugInfo: string[] = []
  let allReels: ApifyReel[] = []

  for (const username of usernames) {
    try {
      const reels = await runApifyActorForUser(username)
      debugInfo.push(`@${username}: ${reels.length} reels from Apify`)
      allReels = allReels.concat(reels)
    } catch (err) {
      debugInfo.push(`@${username}: ERROR — ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  let added = 0
  let skippedViews = 0
  let skippedDate = 0

  for (const reel of allReels) {
    const views = reel.videoViewCount ?? reel.videoPlayCount ?? reel.playCount ?? 0
    const postedAt = reel.timestamp ? new Date(reel.timestamp) : null

    if (!postedAt || postedAt < cutoff) { skippedDate++; continue }
    if (views < minViews) { skippedViews++; continue }

    const reelUrl = reel.url ?? (reel.shortCode ? `https://www.instagram.com/p/${reel.shortCode}/` : null)
    if (!reelUrl) continue

    try {
      const result = await query(
        `INSERT INTO viral_reels (profile, reel_url, views, posted_at, thumbnail_url, video_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (reel_url) DO NOTHING`,
        [reel.ownerUsername ?? 'unknown', reelUrl, views, postedAt.toISOString(), reel.displayUrl ?? reel.images?.[0] ?? null, reel.videoUrl ?? null]
      )
      if (result.rowCount && result.rowCount > 0) added++
    } catch (err) {
      console.error('[scan] insert error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: allReels.length,
    added,
    skippedDate,
    skippedViews,
    debug: debugInfo,
    settings: { minViews, daysBack },
  })
}
