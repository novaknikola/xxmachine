import { one, query } from '@/lib/db'
import { getTrackedProfileUsernames } from './sheet'
import { scanProfile } from './scan'
import { recordSnapshot } from './persist'
import { findNewlyViral, markReported } from './detect'
import { sendViralReport, sendErrorAlert } from './telegram'
import { writeVideosReport } from './sheet-report'
import { SCAN_CONCURRENCY, SCAN_RETRY_DELAY_MS } from './config'
import type { RunSummary, ScannedVideo } from './types'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function scanProfileWithRetry(username: string): Promise<ScannedVideo[] | null> {
  try {
    return await scanProfile(username)
  } catch (firstErr) {
    console.error(`[viral-monitor] scan failed for @${username}, retrying once:`, firstErr instanceof Error ? firstErr.message : firstErr)
    await sleep(SCAN_RETRY_DELAY_MS)
    try {
      return await scanProfile(username)
    } catch (secondErr) {
      console.error(`[viral-monitor] scan failed for @${username} (retry also failed):`, secondErr instanceof Error ? secondErr.message : secondErr)
      return null
    }
  }
}

async function scanAllProfiles(usernames: string[]): Promise<{ videos: ScannedVideo[]; failed: number }> {
  const videos: ScannedVideo[] = []
  let failed = 0
  let i = 0

  async function worker() {
    while (i < usernames.length) {
      const username = usernames[i++]
      const result = await scanProfileWithRetry(username)
      if (result === null) {
        failed++
      } else {
        videos.push(...result)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, usernames.length) }, worker))
  return { videos, failed }
}

/**
 * Orchestrates one full daily pass: sheet → scan → persist → detect → notify.
 * Fully isolated from every other xxmachine workflow — no shared tables, no
 * shared queue, no replicate pipeline involvement.
 */
export async function runViralMonitorDaily(): Promise<RunSummary> {
  // bigserial — comes back as a string, not a number (see types.ts note).
  const runRow = await one<{ id: string }>(
    `INSERT INTO viral_monitor_runs (status) VALUES ('running') RETURNING id`,
  )
  const runId = runRow!.id

  try {
    const usernames = await getTrackedProfileUsernames()
    console.log(`[viral-monitor] run ${runId}: ${usernames.length} profiles from sheet`)

    const { videos, failed } = await scanAllProfiles(usernames)
    console.log(`[viral-monitor] run ${runId}: scanned ${videos.length} videos across ${usernames.length} profiles (${failed} profile failures)`)

    let videosNew = 0
    for (const video of videos) {
      const { isNew } = await recordSnapshot(video)
      if (isNew) videosNew++
    }

    const candidates = await findNewlyViral()
    let viralNew = 0
    if (candidates.length) {
      const sent = await sendViralReport(candidates.map(c => c.video_url))
      if (sent) {
        await markReported(candidates.map(c => c.id))
        viralNew = candidates.length
        console.log(`[viral-monitor] run ${runId}: reported ${viralNew} newly-viral videos`)
      } else {
        console.error(`[viral-monitor] run ${runId}: ${candidates.length} newly-viral videos found but Telegram send failed — left unreported for retry`)
      }
    }

    await query(
      `UPDATE viral_monitor_runs
          SET finished_at = NOW(), status = 'done',
              profiles_total = $2, profiles_failed = $3,
              videos_scanned = $4, videos_new = $5, viral_new = $6
        WHERE id = $1`,
      [runId, usernames.length, failed, videos.length, videosNew, viralNew],
    )

    // Best-effort — a Sheets outage must not fail an otherwise-successful run.
    await writeVideosReport().catch(err =>
      console.error(`[viral-monitor] run ${runId}: sheet report write failed:`, err instanceof Error ? err.message : err),
    )

    return {
      runId,
      status: 'done',
      profilesTotal: usernames.length,
      profilesFailed: failed,
      videosScanned: videos.length,
      videosNew,
      viralNew,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[viral-monitor] run ${runId} failed:`, message)
    await query(
      `UPDATE viral_monitor_runs SET finished_at = NOW(), status = 'failed', error = $2 WHERE id = $1`,
      [runId, message.slice(0, 500)],
    )
    await sendErrorAlert(message)
    return {
      runId,
      status: 'failed',
      profilesTotal: 0,
      profilesFailed: 0,
      videosScanned: 0,
      videosNew: 0,
      viralNew: 0,
      error: message,
    }
  }
}
