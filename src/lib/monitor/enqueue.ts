import { one, query } from '@/lib/db'

export interface EnqueueReelInput {
  id: string
  permalink: string
  videoUrl?: string | null
  thumbnailUrl?: string | null
  views?: number
  likes?: number
  comments?: number
  postedAt?: string | null
}

export interface EnqueueResult {
  added: number
  refreshed: number
  skippedBusy: number
  total: number
  ids: string[]
  hasCharacter: boolean
  profileTracked: boolean
  profileName: string
}

/**
 * Upsert discovery_items as APPROVED + pending_classify for Copy-Paste.
 * Profile casing prefers the tracked_profiles row so character binding resolves.
 */
export async function enqueueDiscoveryReels(
  userId: string,
  username: string,
  reels: EnqueueReelInput[],
): Promise<EnqueueResult> {
  const cleanUsername = username.trim().replace(/^@/, '')
  if (!cleanUsername) throw new Error('username required')
  if (!reels.length) throw new Error('reels[] required')
  if (reels.length > 100) throw new Error('Max 100 reels per request')

  const tracked = await one<{ username: string; character_id: string | null }>(
    `SELECT username, character_id FROM tracked_profiles
      WHERE user_id = $1 AND lower(username) = lower($2)
      LIMIT 1`,
    [userId, cleanUsername],
  )
  const profileName = tracked?.username ?? cleanUsername

  let added = 0
  let refreshed = 0
  let skippedBusy = 0
  const ids: string[] = []

  for (const reel of reels) {
    const contentId = String(reel.id ?? '').trim()
    const contentUrl = String(reel.permalink ?? '').trim()
    if (!contentId || !contentUrl) continue

    const views = Number(reel.views) || 0
    const likes = Number(reel.likes) || 0
    const comments = Number(reel.comments) || 0
    const postedAt = reel.postedAt ? new Date(reel.postedAt) : null
    const postedIso =
      postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt.toISOString() : null

    const existing = await one<{
      id: string
      replicate_status: string
    }>(
      `SELECT id, replicate_status FROM discovery_items
        WHERE user_id = $1 AND content_id = $2`,
      [userId, contentId],
    )

    if (existing) {
      const busy = ['analyzing', 'image_generating', 'image_done', 'video_generating'].includes(
        existing.replicate_status,
      )
      if (busy) {
        skippedBusy++
        ids.push(existing.id)
        continue
      }
      await query(
        `UPDATE discovery_items SET
           admin_status = 'APPROVED',
           replicate_status = CASE
             WHEN replicate_status = 'done' THEN 'pending_classify'
             WHEN replicate_status = 'failed' THEN 'pending_classify'
             WHEN replicate_status = 'skipped' THEN 'pending_classify'
             WHEN replicate_status = 'needs_review' THEN 'pending_classify'
             WHEN replicate_status = 'none' THEN 'pending_classify'
             ELSE replicate_status
           END,
           profile = $3,
           content_url = $4,
           video_url = coalesce($5, video_url),
           thumbnail_url = coalesce($6, thumbnail_url),
           views = greatest(views, $7),
           likes = greatest(likes, $8),
           comments = greatest(comments, $9),
           posted_at = coalesce($10::timestamptz, posted_at)
         WHERE id = $1 AND user_id = $2`,
        [
          existing.id,
          userId,
          profileName,
          contentUrl,
          reel.videoUrl ?? null,
          reel.thumbnailUrl ?? null,
          views,
          likes,
          comments,
          postedIso,
        ],
      )
      refreshed++
      ids.push(existing.id)
      continue
    }

    const inserted = await one<{ id: string }>(
      `INSERT INTO discovery_items
         (user_id, platform, profile, content_url, content_id,
          views, likes, comments, followers, score, velocity,
          thumbnail_url, video_url, posted_at,
          admin_status, replicate_status)
       VALUES
         ($1,'Instagram',$2,$3,$4,$5,$6,$7,0,0,0,$8,$9,$10::timestamptz,
          'APPROVED','pending_classify')
       RETURNING id`,
      [
        userId,
        profileName,
        contentUrl,
        contentId,
        views,
        likes,
        comments,
        reel.thumbnailUrl ?? null,
        reel.videoUrl ?? null,
        postedIso,
      ],
    )
    if (inserted) {
      added++
      ids.push(inserted.id)
    }
  }

  return {
    added,
    refreshed,
    skippedBusy,
    total: ids.length,
    ids,
    hasCharacter: Boolean(tracked?.character_id),
    profileTracked: Boolean(tracked),
    profileName,
  }
}
