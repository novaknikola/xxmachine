import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'

const CRON_SECRET = process.env.CRON_SECRET

export async function GET(req: NextRequest) {
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  // Existing scheduled posts (Telegram/Fanvue)
  const due = await rows<{ id: string }>(
    `SELECT id FROM scheduled_posts WHERE status='approved' AND scheduled_at <= now()`,
  )
  const postResults = await Promise.allSettled(
    due.map(p =>
      fetch(`${base}/api/publish/now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: p.id }),
      }),
    ),
  )

  // Instagram Reels queue
  const dueReels = await rows<{ id: string }>(
    `SELECT id FROM instagram_queue
     WHERE status='pending' AND scheduled_at IS NOT NULL AND scheduled_at <= now()`,
  )
  const reelResults = await Promise.allSettled(
    dueReels.map(r =>
      fetch(`${base}/api/instagram/publish-reel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId: r.id }),
      }),
    ),
  )

  // Instagram token refresh (tokens expiring within 7 days)
  if (dueReels.length > 0 || Math.random() < 0.1) {
    fetch(`${base}/api/instagram/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {})
  }

  return NextResponse.json({
    posts: { processed: due.length, results: postResults.map(r => r.status) },
    reels: { processed: dueReels.length, results: reelResults.map(r => r.status) },
  })
}
