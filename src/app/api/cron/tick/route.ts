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
  // Reset stuck shared-pool jobs that have been processing for > 30 minutes.
  // copy_paste_v2 is excluded: one item is a Seedream keyframe plus a Seedance
  // render, so a legitimate bulk run easily exceeds 30 minutes of wall clock.
  // It is requeued on heartbeat staleness instead (see below).
  await query(
    `UPDATE generation_queue
        SET status = 'pending'
      WHERE status = 'processing'
        AND started_at < now() - interval '30 minutes'
        AND attempts < max_attempts
        AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
                             'copy_paste_v2', 'copy_prompts_generate')`,
  ).catch(err => console.error('[cron/tick] reset stuck queue jobs:', err))

  // copy_paste_v2 and copy_prompts_generate write progressAt after every batch.
  // No progress for 25 minutes means the worker died (deploy/crash), not that
  // it is still grinding — a large Seedream batch legitimately runs for hours.
  await query(
    `UPDATE generation_queue
        SET status = 'pending', started_at = NULL, error = NULL
      WHERE status = 'processing'
        AND job_type IN ('copy_paste_v2', 'copy_prompts_generate')
        AND attempts < max_attempts
        AND COALESCE(
              NULLIF(output->>'progressAt', '')::timestamptz,
              started_at
            ) < now() - interval '25 minutes'`,
  ).catch(err => console.error('[cron/tick] requeue stale copy_paste_v2 jobs:', err))

  await query(
    `UPDATE generation_queue
        SET status = 'failed',
            error = COALESCE(error, 'Job stalled — no progress after max attempts'),
            finished_at = now()
      WHERE status = 'processing'
        AND job_type IN ('copy_paste_v2', 'copy_prompts_generate')
        AND attempts >= max_attempts
        AND COALESCE(
              NULLIF(output->>'progressAt', '')::timestamptz,
              started_at
            ) < now() - interval '25 minutes'`,
  ).catch(err => console.error('[cron/tick] fail exhausted heartbeat jobs:', err))

  // My Pod resume lease: worker heartbeats progressAt ~every 60s during Comfy/Python work.
  // If heartbeat stops (deploy/crash), requeue to pending and continue from done_items.
  // Exhausted attempts → fail instead of looping forever.
  await query(
    `UPDATE generation_queue
        SET status = 'pending',
            started_at = NULL,
            error = NULL
      WHERE status = 'processing'
        AND job_type IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk')
        AND attempts < max_attempts
        AND COALESCE(
              NULLIF(output->>'progressAt', '')::timestamptz,
              started_at
            ) < now() - interval '25 minutes'`,
  ).catch(err => console.error('[cron/tick] requeue stale my-pod jobs:', err))

  await query(
    `UPDATE generation_queue
        SET status = 'failed',
            error = COALESCE(error, 'My Pod job stalled — no heartbeat after max attempts'),
            finished_at = now()
      WHERE status = 'processing'
        AND job_type IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk')
        AND attempts >= max_attempts
        AND COALESCE(
              NULLIF(output->>'progressAt', '')::timestamptz,
              started_at
            ) < now() - interval '25 minutes'`,
  ).catch(err => console.error('[cron/tick] fail exhausted my-pod jobs:', err))

  let queueStarted = 0
  try {
    // My Pod jobs run on the user's own GPU — separate claim path below.
    const processingCount = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM generation_queue
        WHERE status = 'processing'
          AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk')`,
    )
    const slots = Math.max(0, QUEUE_CONCURRENCY - (processingCount?.count ?? 0))

    if (slots > 0) {
      const pending = await rows<{ id: string }>(
        `SELECT id FROM generation_queue
          WHERE status = 'pending'
            AND job_type NOT IN ('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk')
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

  // ── My Pod jobs — 1 concurrent per pod; unpinned jobs serialize per user ──
  let comfyStarted = 0
  try {
    const myPodTypes = `('comfyui_pod_bulk', 'my_pod_i2v', 'my_pod_animate', 'my_pod_talk')`
    const pendingComfy = await rows<{ id: string; user_id: string; pod_session_id: string | null }>(
      `SELECT id, user_id, pod_session_id FROM generation_queue
        WHERE status = 'pending' AND job_type IN ${myPodTypes}
        ORDER BY created_at`,
    )
    const processing = await rows<{ user_id: string; pod_session_id: string | null }>(
      `SELECT user_id, pod_session_id FROM generation_queue
        WHERE status = 'processing' AND job_type IN ${myPodTypes}`,
    )
    const busyPods = new Set(
      processing.map(r => r.pod_session_id).filter((id): id is string => !!id),
    )
    const usersWithAnyProcessing = new Set(processing.map(r => r.user_id))
    const usersWithUnpinnedProcessing = new Set(
      processing.filter(r => !r.pod_session_id).map(r => r.user_id),
    )

    for (const job of pendingComfy) {
      if (job.pod_session_id) {
        if (busyPods.has(job.pod_session_id)) continue
        // Unpinned worker may be using any pod via fallback — don't stack on top.
        if (usersWithUnpinnedProcessing.has(job.user_id)) continue
      } else if (usersWithAnyProcessing.has(job.user_id)) {
        continue
      }
      const claimed = await one<{ id: string }>(
        `UPDATE generation_queue
            SET status = 'processing', started_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [job.id],
      )
      if (claimed) {
        if (job.pod_session_id) busyPods.add(job.pod_session_id)
        usersWithAnyProcessing.add(job.user_id)
        if (!job.pod_session_id) usersWithUnpinnedProcessing.add(job.user_id)
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

  // ── My Pod session health — all non-expired sessions ──
  let podHealthChecked = 0
  try {
    const sessions = await rows<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM pod_sessions WHERE expires_at > now()`,
    )
    const { refreshPodSessionHealth } = await import('@/lib/my-pod/session')
    for (const s of sessions) {
      await refreshPodSessionHealth(s.user_id, s.id).catch(err =>
        console.error('[cron/tick] pod health', s.id, err),
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
