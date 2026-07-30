import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { fetchAllStats } from '@/lib/stats'
import { runDueProfileScans } from '@/lib/monitor/process-item'
import { processDriveExports } from '@/lib/drive-archive/process'

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
  // Reset stuck shared-pool jobs that have been processing for > 30 minutes
  await query(
    `UPDATE generation_queue
        SET status = 'pending'
      WHERE status = 'processing'
        AND started_at < now() - interval '30 minutes'
        AND attempts < max_attempts
        AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')`,
  ).catch(err => console.error('[cron/tick] reset stuck queue jobs:', err))

  // My Pod: fail jobs with no progress for > 10 minutes (don't silently requeue forever)
  await query(
    `UPDATE generation_queue
        SET status = 'failed',
            error = COALESCE(error, 'No progress for 10+ minutes — pod may be offline'),
            finished_at = now()
      WHERE status = 'processing'
        AND job_type IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')
        AND started_at < now() - interval '10 minutes'
        AND (
          output IS NULL
          OR NOT (output ? 'stage')
          OR (output->>'stage') IN ('validating', 'uploading', 'downloading_inputs', 'building_graph')
        )
        AND done_items = 0`,
  ).catch(err => console.error('[cron/tick] fail stuck my-pod jobs:', err))

  // Long-running My Pod renders can exceed 10 min once stage=running — only fail if done_items
  // hasn't moved for 90 minutes wall time.
  await query(
    `UPDATE generation_queue
        SET status = 'failed',
            error = COALESCE(error, 'My Pod job exceeded 90 minutes — marked failed'),
            finished_at = now()
      WHERE status = 'processing'
        AND job_type IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')
        AND started_at < now() - interval '90 minutes'`,
  ).catch(err => console.error('[cron/tick] fail long my-pod jobs:', err))

  let queueStarted = 0
  try {
    // My Pod jobs run on the user's own GPU — separate claim path below.
    const processingCount = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM generation_queue
        WHERE status = 'processing'
          AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')`,
    )
    const slots = Math.max(0, QUEUE_CONCURRENCY - (processingCount?.count ?? 0))

    if (slots > 0) {
      const pending = await rows<{ id: string }>(
        `SELECT id FROM generation_queue
          WHERE status = 'pending'
            AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')
          ORDER BY created_at LIMIT $1`,
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

  // ── My Pod jobs (comfyui_pod_bulk + i2v + animate) — 1 concurrent per user ──
  let comfyStarted = 0
  try {
    const myPodTypes = `('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate')`
    const pendingComfy = await rows<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM generation_queue
        WHERE status = 'pending' AND job_type IN ${myPodTypes}
        ORDER BY created_at`,
    )
    const busyUsers = new Set(
      (await rows<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM generation_queue
          WHERE status = 'processing' AND job_type IN ${myPodTypes}`,
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
        }).catch(err => console.error('[cron/tick] fire my-pod process job:', err))
      }
    }
  } catch (err) {
    console.error('[cron/tick] my-pod queue processing error:', err)
  }

  // ── My Pod session health (HTTP every tick; ~5 min cadence if cron is 5 min) ──
  let podHealthChecked = 0
  try {
    const sessions = await rows<{ user_id: string }>(
      `SELECT user_id FROM pod_sessions WHERE expires_at > now()`,
    )
    const { refreshPodSessionHealth } = await import('@/lib/my-pod/session')
    for (const s of sessions) {
      await refreshPodSessionHealth(s.user_id).catch(err =>
        console.error('[cron/tick] pod health', s.user_id, err),
      )
      podHealthChecked++
    }
  } catch (err) {
    console.error('[cron/tick] pod session health error:', err)
  }

  // ── Daily IG profile monitor (Copy-Paste pipeline) ────────────
  let monitorScans: Awaited<ReturnType<typeof runDueProfileScans>> = []
  try {
    monitorScans = await runDueProfileScans(base, CRON_SECRET)
  } catch (err) {
    console.error('[cron/tick] monitor scan error:', err)
  }

  // ── Google Drive auto-archive uploads ─────────────────────────
  let driveArchive: Awaited<ReturnType<typeof processDriveExports>> | { error: string } = {
    processed: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  }
  try {
    driveArchive = await processDriveExports({ limit: 5 })
  } catch (err) {
    console.error('[cron/tick] drive archive error:', err)
    driveArchive = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json({
    posts: { processed: due.length, results: postResults.map(r => r.status) },
    reels: { processed: dueReels.length, results: reelResults.map(r => r.status) },
    stats: statsResult,
    queue: { started: queueStarted, comfyuiStarted: comfyStarted, podHealthChecked },
    monitor: monitorScans,
    driveArchive,
  })
}
