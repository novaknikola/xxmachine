import { one, query } from '@/lib/db'
import type { ScannedVideo } from './types'

/**
 * Upserts a video's latest stats and always appends a snapshot row, so view
 * growth over time is preserved even across repeated scans of the same reel.
 * Returns whether this was the first time the video was seen.
 */
export async function recordSnapshot(video: ScannedVideo): Promise<{ id: string; isNew: boolean }> {
  const postedAt = video.postedAt ? new Date(video.postedAt).toISOString() : null

  const row = await one<{ id: string; xmax: string }>(
    `INSERT INTO viral_monitor_videos
       (profile_username, shortcode, video_url, posted_at, last_checked_at, last_views, followers)
     VALUES ($1, $2, $3, $4, NOW(), $5, $6)
     ON CONFLICT (video_url) DO UPDATE
       SET last_checked_at = NOW(),
           last_views = EXCLUDED.last_views,
           -- A failed follower lookup on a later scan must not erase a
           -- previously known value — keep the old one when this scan got null.
           followers = COALESCE(EXCLUDED.followers, viral_monitor_videos.followers)
     RETURNING id, xmax`,
    [video.profileUsername, video.shortcode, video.url, postedAt, video.views, video.followers],
  )
  if (!row) throw new Error(`Failed to upsert viral_monitor_videos row for ${video.url}`)

  // xmax = 0 means this INSERT created the row; a nonzero xmax means the
  // ON CONFLICT UPDATE branch fired instead. Standard Postgres upsert tell.
  const isNew = row.xmax === '0'

  await query(
    `INSERT INTO viral_monitor_snapshots (video_id, views, checked_at) VALUES ($1, $2, NOW())`,
    [row.id, video.views],
  )

  return { id: row.id, isNew }
}
