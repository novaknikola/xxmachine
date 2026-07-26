import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'
import { scanTrackedProfile } from '@/lib/monitor/scan'
import { processNewItems } from '@/lib/monitor/process-item'
import { notifyNewPosts } from '@/lib/monitor/notify'
import type { TrackedProfileRow } from '@/lib/monitor/types'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  const cronHeader = req.headers.get('x-cron-secret')
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET

  let userId: string
  let profileId: string

  const body = await req.json().catch(() => ({}))

  if (isCron) {
    userId = body.user_id
    profileId = body.profile_id
    if (!userId || !profileId) {
      return NextResponse.json({ error: 'user_id and profile_id required for cron scan' }, { status: 400 })
    }
  } else {
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth
    userId = auth.id
    profileId = body.profile_id
    if (!profileId) return NextResponse.json({ error: 'profile_id required' }, { status: 400 })
  }

  const profile = await one<TrackedProfileRow>(
    `SELECT * FROM tracked_profiles WHERE id = $1 AND user_id = $2`,
    [profileId, userId],
  )
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  try {
    const result = await scanTrackedProfile(userId, profile)
    const { added, newItemIds, scanned, listed, skippedAge, skippedScore, skippedDuplicate, source } = result

    if (added > 0) {
      await notifyNewPosts(userId, profile.username, added).catch(() => {})
    }

    let processed = 0
    if (newItemIds.length > 0 && profile.autopilot) {
      const results = await processNewItems(userId, newItemIds)
      processed = results.filter(r => r.ok).length
    } else if (newItemIds.length > 0) {
      // Mark new items for manual review
      for (const id of newItemIds) {
        await query(
          `UPDATE discovery_items SET replicate_status = 'pending_classify'
            WHERE id = $1 AND replicate_status = 'none'`,
          [id],
        )
      }
    }

    return NextResponse.json({
      ok: true,
      added,
      scanned,
      listed,
      skippedAge,
      skippedScore,
      skippedDuplicate,
      newItemIds,
      processed,
      source,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Scan failed' },
      { status: 500 },
    )
  }
}
