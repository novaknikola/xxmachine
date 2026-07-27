import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { enqueueDiscoveryReels, type EnqueueReelInput } from '@/lib/monitor/enqueue'
import { scheduleAutoClassify } from '@/lib/monitor/auto-classify'

/**
 * IG Downloader → Copy-Paste pending.
 * Upserts discovery_items as APPROVED + pending_classify, then auto-classifies.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json()
  const username = String(body.username ?? '')
  const reels = (Array.isArray(body.reels) ? body.reels : []) as EnqueueReelInput[]

  try {
    const result = await enqueueDiscoveryReels(user.id, username, reels)
    scheduleAutoClassify(user.id, result.ids)
    return NextResponse.json({ ok: true, classifying: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Enqueue failed'
    const status =
      message.includes('required') || message.startsWith('Max ') ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
