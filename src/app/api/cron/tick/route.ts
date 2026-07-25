import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { fetchAllStats } from '@/lib/stats'

const CRON_SECRET = process.env.CRON_SECRET
const QUEUE_CONCURRENCY = 2

export async function GET(req: NextRequest) {
  // Fail closed: without a configured secret this endpoint would be publicly callable.
  if (!CRON_SECRET) {
    console.error('[cron/tick] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
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

  // Expire subscriptions that have passed their expiry date
  await query(
    `UPDATE users SET subscription_status = 'expired'
     WHERE subscription_status = 'active' AND subscription_expires_at < now()`,
  ).catch(err => console.error('[cron/tick] expire subscriptions:', err))

  // Daily analytics stats fetch — run once per day based on last fetched_at
  let statsResult: string = 'skipped'
  const lastStats = await one<{ fetched_at: Date }>(
    `SELECT fetched_at FROM platform_stats ORDER BY fetched_at DESC LIMIT 1`
  )
  const hoursSinceLast = lastStats
    ? (Date.now() - new Date(lastStats.fetched_at).getTime()) / 3_600_000
    : Infinity
  if (hoursSinceLast >= 23) {
    fetchAllStats()
      .then(() => { statsResult = 'started' })
      .catch(err => console.error('[cron/tick] stats:', err))
    statsResult = 'started'
  }

  // ── Generation queue processing ───────────────────────────────
  // Reset stuck jobs that have been processing for > 30 minutes
  await query(
    `UPDATE generation_queue
        SET status = 'pending'
      WHERE status = 'processing'
        AND started_at < now() - interval '30 minutes'
        AND attempts < max_attempts`,
  ).catch(err => console.error('[cron/tick] reset stuck queue jobs:', err))

  let queueStarted = 0
  try {
    // comfyui_pod_bulk runs on the user's own pod, not our compute — it has its
    // own claim path below and must not eat into this shared pool.
    const processingCount = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM generation_queue WHERE status = 'processing' AND job_type != 'comfyui_pod_bulk'`,
    )
    const slots = Math.max(0, QUEUE_CONCURRENCY - (processingCount?.count ?? 0))

    if (slots > 0) {
      const pending = await rows<{ id: string }>(
        `SELECT id FROM generation_queue WHERE status = 'pending' AND job_type != 'comfyui_pod_bulk' ORDER BY created_at LIMIT $1`,
        [slots],
      )

      for (const job of pending) {
        const claimed = await one<{ id: string }>(
          `UPDATE generation_queue
              SET status = 'processing', started_at = now(), attempts = attempts + 1
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [job.id],
        )
        if (claimed) {
          queueStarted++
          // Fire-and-forget — process route updates the DB when done
          fetch(`${base}/api/queue/process/${job.id}`, {
            method: 'POST',
            headers: { 'x-cron-secret': CRON_SECRET },
          }).catch(err => console.error('[cron/tick] fire process job:', err))
        }
      }
    }
  } catch (err) {
    console.error('[cron/tick] queue processing error:', err)
  }

  // ── ComfyUI pod bulk jobs — no shared resource to protect, just cap at
  // 1 concurrent batch per user (guards against duplicate submissions racing
  // on the same pod, not a resource limit).
  let comfyStarted = 0
  try {
    const pendingComfy = await rows<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM generation_queue WHERE status = 'pending' AND job_type = 'comfyui_pod_bulk' ORDER BY created_at`,
    )
    const busyUsers = new Set(
      (await rows<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM generation_queue WHERE status = 'processing' AND job_type = 'comfyui_pod_bulk'`,
      )).map(r => r.user_id),
    )

    for (const job of pendingComfy) {
      if (busyUsers.has(job.user_id)) continue
      const claimed = await one<{ id: string }>(
        `UPDATE generation_queue
            SET status = 'processing', started_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [job.id],
      )
      if (claimed) {
        busyUsers.add(job.user_id)
        comfyStarted++
        fetch(`${base}/api/queue/process/${job.id}`, {
          method: 'POST',
          headers: { 'x-cron-secret': CRON_SECRET },
        }).catch(err => console.error('[cron/tick] fire comfyui process job:', err))
      }
    }
  } catch (err) {
    console.error('[cron/tick] comfyui queue processing error:', err)
  }

  return NextResponse.json({
    posts: { processed: due.length, results: postResults.map(r => r.status) },
    reels: { processed: dueReels.length, results: reelResults.map(r => r.status) },
    stats: statsResult,
    queue: { started: queueStarted, comfyuiStarted: comfyStarted },
  })
}
