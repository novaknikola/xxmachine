/**
 * Drive folder → one video_repurpose job per video.
 *
 * Lifted out of /api/queue/submit so the Telegram bot can run the same path.
 * That route authenticates with a session, which a webhook does not have, so
 * the caller passes the user id instead.
 */
import { one } from '@/lib/db'
import { listDriveFiles } from '@/lib/google-drive'
import { sanitizeArchiveLabel } from '@/lib/drive-archive/label'
import type { VideoEffectOpts } from '@/lib/video-ffmpeg'

/** Extensions the repurpose ffmpeg path can actually open. */
const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv)$/i

export const DEFAULT_REPURPOSE_EFFECTS: VideoEffectOpts = {
  brightness: true, contrast: true, saturation: true,
  hue: true, speed: true, flipH: true, crop: true, fade: false,
}

/**
 * Accepts a full Drive URL or a bare id.
 *
 * People paste whatever the Drive UI gave them — the folder page, a "share"
 * link with a query string, sometimes just the id out of the address bar.
 */
export function parseDriveFolderId(raw: string): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/)
    ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (m) return m[1]
  // A bare id: Drive ids are long and have no spaces or dots.
  if (/^[A-Za-z0-9_-]{15,}$/.test(s)) return s
  return null
}

export class RepurposeFolderError extends Error {}

/**
 * One video_repurpose job for one already-rendered video URL.
 *
 * Shared by the folder fan-out below and the bot's Repurpose button, so the
 * job input shape lives in exactly one place.
 */
export async function enqueueRepurposeJob(opts: {
  userId: string
  videoUrl: string
  videoName: string
  count: number
  effects?: VideoEffectOpts
  outputDriveFolderId?: string | null
  characterKey?: string | null
  seriesLabel?: string | null
  driveFileId?: string | null
}): Promise<string | null> {
  const count = Math.min(100, Math.max(1, Math.round(opts.count)))
  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'video_repurpose', $2, $3)
     RETURNING id`,
    [
      opts.userId,
      JSON.stringify({
        videoUrl: opts.videoUrl,
        videoName: opts.videoName,
        driveFileId: opts.driveFileId ?? null,
        count,
        baseSeed: Math.floor(Math.random() * 0xffffff),
        effects: opts.effects ?? DEFAULT_REPURPOSE_EFFECTS,
        archiveToDrive: true,
        characterKey: opts.characterKey ?? null,
        outputDriveFolderId: (opts.outputDriveFolderId || '').trim() || null,
        seriesLabel: sanitizeArchiveLabel(opts.seriesLabel) || null,
      }),
      count,
    ],
  )
  return row?.id ?? null
}

export interface EnqueueRepurposeFromDriveResult {
  jobIds: string[]
  videoNames: string[]
}

export async function enqueueRepurposeFromDriveFolder(opts: {
  userId: string
  folderId: string
  count: number
  effects?: VideoEffectOpts
  /** Override destination; empty keeps the dated archive tree. */
  outputDriveFolderId?: string | null
  seriesLabel?: string | null
}): Promise<EnqueueRepurposeFromDriveResult> {
  const count = Math.min(100, Math.max(1, Math.round(opts.count)))

  let files
  try {
    // Platform service account, not user OAuth: input folders are typically
    // *shared with* it, which the drive.file scope cannot see.
    files = await listDriveFiles(opts.folderId)
  } catch (err) {
    throw new RepurposeFolderError(
      `Could not read that Drive folder: ${err instanceof Error ? err.message : 'failed'}`,
    )
  }

  const videos = files.filter(f => VIDEO_EXT_RE.test(f.name))
  if (!videos.length) {
    throw new RepurposeFolderError('That folder has no videos (mp4/webm/mov/mkv).')
  }

  const jobIds: string[] = []
  for (const f of videos) {
    const id = await enqueueRepurposeJob({
      userId: opts.userId,
      videoUrl: '',
      videoName: f.name,
      driveFileId: f.id,
      count,
      effects: opts.effects,
      outputDriveFolderId: opts.outputDriveFolderId,
      seriesLabel: opts.seriesLabel,
    })
    if (id) jobIds.push(id)
  }

  return { jobIds, videoNames: videos.map(f => f.name) }
}
