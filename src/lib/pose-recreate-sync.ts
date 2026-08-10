/**
 * Fully automatic pose_library refresh from Pinterest boards, so the user
 * never has to manually re-run an import script. A board opts in by naming
 * convention — title starts with "[format]", e.g. "[stories] IG bot - Stories"
 * — no separate mapping table or UI needed.
 *
 * Reuses fetchBoard/parseBoardRef from lib/pinterest (the same functions
 * api/pinterest/boards/route.ts's manual "re-sync" button calls) rather than
 * hitting that route over HTTP — this runs from cron, already server-side.
 * The pin upsert is a deliberate near-copy of that route's own upsert loop:
 * small enough that duplicating it here beats importing from a route file.
 */
import { rows, one, query } from '@/lib/db'
import { fetchBoard, parseBoardRef } from '@/lib/pinterest'

const FORMAT_PREFIX = /^\s*\[(posts|stories|carousels|fanvue_sfw|fanvue_nsfw|reels)\]/i

// Re-fetching a board hits Pinterest itself — don't do that more than this
// often per board, regardless of how frequently cron/tick runs.
const SYNC_INTERVAL_MS = 30 * 60 * 1000

export async function syncPoseLibraryFromPinterest(): Promise<{
  boardsChecked: number
  boardsSynced: number
  posesAdded: number
}> {
  const boards = await rows<{
    id: string
    user_id: string
    title: string | null
    board_url: string
    synced_at: string | null
  }>(
    `SELECT id, user_id, title, board_url, synced_at FROM pinterest_boards
      WHERE is_active = true AND title ~* '^\\s*\\[(posts|stories|carousels|fanvue_sfw|fanvue_nsfw|reels)\\]'`,
  )

  let boardsSynced = 0
  let posesAdded = 0

  for (const board of boards) {
    const match = board.title?.match(FORMAT_PREFIX)
    if (!match) continue
    const format = match[1].toLowerCase()
    const nsfw = format === 'fanvue_nsfw'

    const stale = !board.synced_at || Date.now() - new Date(board.synced_at).getTime() > SYNC_INTERVAL_MS
    if (stale) {
      try {
        const ref = parseBoardRef(board.board_url)
        const fetched = await fetchBoard(ref)
        for (const pin of fetched.pins) {
          await query(
            `INSERT INTO pinterest_pins (board_id, pin_key, pin_url, title, image_url, image_url_hd)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (board_id, pin_key) DO UPDATE
               SET title = COALESCE(EXCLUDED.title, pinterest_pins.title),
                   pin_url = COALESCE(EXCLUDED.pin_url, pinterest_pins.pin_url)`,
            [board.id, pin.pinKey, pin.pinUrl, pin.title, pin.imageUrl, pin.imageUrlHd],
          )
        }
        const counted = await one<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pinterest_pins WHERE board_id = $1 AND is_active`,
          [board.id],
        )
        await query(
          `UPDATE pinterest_boards SET pin_count = $2, synced_at = now(), last_error = NULL WHERE id = $1`,
          [board.id, counted?.n ?? 0],
        )
        boardsSynced++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'sync failed'
        await query(`UPDATE pinterest_boards SET last_error = $2 WHERE id = $1`, [board.id, msg]).catch(() => {})
        console.error('[pose-recreate-sync] board sync failed:', board.id, msg)
        // Still worth trying to copy whatever pins already exist from a
        // previous successful sync — fall through rather than continue.
      }
    }

    const pins = await rows<{ image_url_hd: string }>(
      `SELECT image_url_hd FROM pinterest_pins WHERE board_id = $1 AND is_active = true`,
      [board.id],
    )
    for (const pin of pins) {
      const existing = await one<{ id: string }>(
        `SELECT id FROM pose_library WHERE user_id = $1 AND image_url = $2 AND content_format = $3`,
        [board.user_id, pin.image_url_hd, format],
      )
      if (existing) continue
      await query(
        `INSERT INTO pose_library (user_id, image_url, nsfw, content_format) VALUES ($1, $2, $3, $4)`,
        [board.user_id, pin.image_url_hd, nsfw, format],
      )
      posesAdded++
    }
  }

  return { boardsChecked: boards.length, boardsSynced, posesAdded }
}

/**
 * cron/tick already has a generic 60-minute stale-heartbeat sweep for
 * copy_prompts_generate (and other job types) — correct as a last resort,
 * but 60 minutes is a bad user experience for someone waiting in Telegram,
 * and crucially that sweep never notifies anyone. This runs a much shorter
 * check (matching the in-process pollAndDeliver threshold in the webhook
 * route) scoped only to pose-recreate's own jobs — identified by
 * folderName starting with "adhoc-", the label generateFromReference always
 * uses — and pushes a Telegram message either way, which covers the exact
 * gap that caused today's incident: the submitting process (and its
 * in-memory pollAndDeliver loop) died in a deploy, so nothing was left to
 * notice or report it.
 */
const ADHOC_STALE_MS = 12 * 60 * 1000

export async function reapStaleAdhocJobs(): Promise<void> {
  // Interval is a compile-time constant, not a query param — parameterizing
  // an INTERVAL cast is needlessly fragile (numeric-vs-text concatenation
  // across pg driver versions) for a value that never changes at runtime.
  const stale = await rows<{
    id: string
    user_id: string
    output: { copyPromptsRows?: { images: string[] }[] } | null
  }>(
    `SELECT id, user_id, output FROM generation_queue
      WHERE status = 'processing'
        AND job_type = 'copy_prompts_generate'
        AND input->>'folderName' LIKE 'adhoc-%'
        AND COALESCE(NULLIF(output->>'progressAt', '')::timestamptz, started_at)
              < now() - interval '12 minutes'`,
  )

  for (const job of stale) {
    const cancelled = await query(
      `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2 AND status='processing'`,
      [`Auto-cancelled — no progress for ${Math.round(ADHOC_STALE_MS / 60000)}+ minutes (worker likely died mid-run, e.g. a deploy)`, job.id],
    )
    if (!cancelled.rowCount) continue // pollAndDeliver's own in-process check already won this race

    const user = await one<{ telegram_recreate_chat_id: number | null }>(
      `SELECT telegram_recreate_chat_id FROM users WHERE id = $1`,
      [job.user_id],
    )
    if (!user?.telegram_recreate_chat_id) continue

    const { sendText, sendMediaGroup } = await import('@/lib/telegram-recreate')
    const chatId = user.telegram_recreate_chat_id
    const images = (job.output?.copyPromptsRows ?? []).flatMap(r => r.images ?? [])
    if (images.length) {
      for (let g = 0; g < images.length; g += 10) {
        await sendMediaGroup(chatId, images.slice(g, g + 10), `⚠️ Partial result (${images.length}) before it stalled`).catch(() => {})
      }
    }
    await sendText(chatId, '❌ Generation stalled with no progress — cancelled automatically. Try again.').catch(() => {})
  }
}
