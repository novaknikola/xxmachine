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
