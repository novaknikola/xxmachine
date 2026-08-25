import { rows, query } from '@/lib/db'
import { VIEWS_THRESHOLD, WINDOW_DAYS, FOLLOWERS_MULTIPLIER } from './config'

export interface ViralCandidate {
  id: string
  video_url: string
}

/**
 * Videos that have crossed EITHER the flat view threshold OR
 * followers * FOLLOWERS_MULTIPLIER, within the configured number of days of
 * posting, and have not yet been included in a Telegram report.
 */
export async function findNewlyViral(): Promise<ViralCandidate[]> {
  return rows<ViralCandidate>(
    `SELECT id, video_url
       FROM viral_monitor_videos
      WHERE reported_at IS NULL
        AND posted_at IS NOT NULL
        AND last_checked_at - posted_at <= ($1 || ' days')::interval
        AND (
          last_views >= $2
          OR (followers IS NOT NULL AND last_views >= followers * $3)
        )
      ORDER BY posted_at`,
    [WINDOW_DAYS, VIEWS_THRESHOLD, FOLLOWERS_MULTIPLIER],
  )
}

export async function markReported(ids: string[]): Promise<void> {
  if (!ids.length) return
  await query(
    `UPDATE viral_monitor_videos SET reported_at = NOW() WHERE id = ANY($1::uuid[])`,
    [ids],
  )
}
