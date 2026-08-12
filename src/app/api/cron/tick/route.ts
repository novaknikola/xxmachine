import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { fetchAllStats } from '@/lib/stats'
import { runDueProfileScans } from '@/lib/monitor/process-item'
import { runDailyAutoSchedule } from '@/lib/instagram/auto-schedule'
import { processDriveExports } from '@/lib/drive-archive/process'
import { internalBaseUrl } from '@/lib/internal-url'
import { syncPoseLibraryFromPinterest, reapStaleAdhocJobs } from '@/lib/pose-recreate-sync'
import { notifyMonitorUser } from '@/lib/monitor/notify'

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

  // Loopback: these fire the queue workers, which run far longer than the
  // 300s nginx allows on the public host. See internalBaseUrl().
  const base = internalBaseUrl()

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

  // Instagram daily auto-schedule — draws unqueued Drive videos per connected
  // account, inserts as 'pending_approval' (never picked up by the reel query
  // above until a human approves it in the UI).
  let autoSchedule: Awaited<ReturnType<typeof runDailyAutoSchedule>> = { ran: false, created: 0 }
  try {
    autoSchedule = await runDailyAutoSchedule()
  } catch (err) {
    console.error('[cron/tick] auto-schedule error:', err)
  }

  // Pose-recreate bot: boards titled "[format] ..." auto re-sync (throttled
  // internally to every 30min per board) and any new pins flow straight into
  // pose_library — no manual import step.
  try {
    await syncPoseLibraryFromPinterest()
  } catch (err) {
    console.error('[cron/tick] pose-recreate Pinterest sync error:', err)
  }

  // Pose-recreate bot: cancel + notify its own jobs within ~12min of a stale
  // heartbeat, well before the generic 60min sweep below (which never
  // notifies anyone) would ever catch them.
  try {
    await reapStaleAdhocJobs()
  } catch (err) {
    console.error('[cron/tick] pose-recreate stale-job reap error:', err)
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
                             'copy_paste_v2', 'copy_prompts_generate', 'seedance_i2v', 'infinite_talk')`,
  ).catch(err => console.error('[cron/tick] reset stuck queue jobs:', err))

  // copy_paste_v2 and copy_prompts_generate write progressAt after every batch.
  // Seedance video-edit alone can legitimately run 45 minutes (see
  // SEEDANCE_ABORT_MS in monitor/replicate.ts) and up to 2 items run in
  // parallel per batch, so this must stay well above that or it flags a job
  // that is still genuinely polling. No progress for 60 minutes means the
  // worker actually died (deploy/crash) — a large Seedream-only batch still
  // heartbeats between items, so that case doesn't hit this at all.
  //
  // This never auto-requeues: a dead worker can leave a paid WaveSpeed call
  // in flight with no local record of it, and resubmitting blind risks paying
  // for the same render twice. Mark it failed and let a person decide,
  // after checking whether the original call actually billed.
  //
  // Also notify — this used to be the "never notifies anyone" sweep called
  // out above; a person waiting in Telegram deserves the same push
  // reapStaleAdhocJobs already gives pose-recreate, not silence for an hour.
  // Per-row instead of one bulk UPDATE so each notify is tied to the exact
  // job it fired for; the status='processing' guard on the UPDATE still
  // makes this race-safe against a concurrent tick the same way the old
  // single statement was.
  const STALE_JOB_ERROR = 'Job stalled — no progress for 60 minutes. Check WaveSpeed usage before resubmitting; the original call may have already billed.'
  try {
    const staleJobs = await rows<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM generation_queue
        WHERE status = 'processing'
          AND job_type IN ('copy_paste_v2', 'copy_prompts_generate', 'seedance_i2v', 'infinite_talk')
          AND COALESCE(
                NULLIF(output->>'progressAt', '')::timestamptz,
                started_at
              ) < now() - interval '60 minutes'`,
    )
    for (const job of staleJobs) {
      const failed = await query(
        `UPDATE generation_queue SET status = 'failed', error = COALESCE(error, $1), finished_at = now()
          WHERE id = $2 AND status = 'processing'`,
        [STALE_JOB_ERROR, job.id],
      )
      if (failed.rowCount) {
        await notifyMonitorUser(job.user_id, `❌ ${STALE_JOB_ERROR}`).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[cron/tick] fail stale heartbeat jobs:', err)
  }

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

  // ── Orphaned analyses ─────────────────────────────────────────
  //
  // scheduleAutoClassify runs its work in Next's after(), i.e. in this process
  // and not in a queue. A deploy calls pm2 reload, the process goes away
  // mid-analysis, and the item is left in pending_classify with nobody to
  // retry it — items sat in that state for three days. The pipeline logs show
  // it plainly: a probe line, then "Ready on http://localhost:3000".
  //
  // Deliberately not a status change: an item picked up here is analysed for
  // real, so a genuinely queued one just gets analysed slightly early rather
  // than being marked failed.
  let orphanedClassified = 0
  try {
    const orphans = await rows<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM discovery_items
        WHERE replicate_status = 'pending_classify'
          AND video_url IS NOT NULL
          -- Old enough that any in-process run would have finished or died.
          AND discovered_at < now() - interval '5 minutes'
        ORDER BY discovered_at
        LIMIT 3`,
    )
    if (orphans.length) {
      const { classifyDiscoveryItem } = await import('@/lib/monitor/process-item')
      for (const o of orphans) {
        try {
          await classifyDiscoveryItem(o.id, o.user_id)
          orphanedClassified++
        } catch (err) {
          // classifyDiscoveryItem writes replicate_status='failed' itself, so a
          // dead source URL leaves the tick and stops being retried forever.
          console.error('[cron/tick] orphan classify', o.id, err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.error('[cron/tick] orphan sweep error:', err)
  }

  // ── Stalled batch confirmations ───────────────────────────────
  //
  // Same failure mode as the orphaned-analyses sweep above, one step later:
  // scheduleAutoClassify's onClassified callback (which sends the "confirm
  // replicate?" Telegram message) also runs inside that same after()
  // continuation, and has now twice silently failed to fire on a real batch
  // even though every item finished classifying with no error. item_ids is
  // written synchronously at submit time (see setItemIds in telegram-batch.ts)
  // specifically so this sweep has something to check independent of whether
  // that callback ever ran.
  let stalledBatchesFinalized = 0
  try {
    const stalled = await rows<{ id: string }>(
      `SELECT tb.id FROM telegram_batches tb
        WHERE tb.status = 'submitted'
          AND coalesce(array_length(tb.classified_item_ids, 1), 0) = 0
          AND coalesce(array_length(tb.item_ids, 1), 0) > 0
          AND tb.updated_at < now() - interval '90 seconds'
          AND NOT EXISTS (
            SELECT 1 FROM discovery_items di
             WHERE di.id = ANY(tb.item_ids)
               AND di.replicate_status IN ('none', 'pending_classify', 'analyzing')
          )
        ORDER BY tb.updated_at
        LIMIT 5`,
    )
    if (stalled.length) {
      const { getBatch, finalizeBatchClassification } = await import('@/lib/monitor/telegram-batch')
      for (const s of stalled) {
        try {
          const batch = await getBatch(s.id)
          if (batch) {
            await finalizeBatchClassification(batch)
            stalledBatchesFinalized++
          }
        } catch (err) {
          console.error('[cron/tick] stalled batch finalize', s.id, err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.error('[cron/tick] stalled batch sweep error:', err)
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
    orphanedClassified,
    stalledBatchesFinalized,
    monitor: monitorScans,
    driveArchive,
    autoSchedule,
  })
}
