/**
 * Copy-Paste replication via Wan 3.0 reference-to-video (see wan-reference.ts
 * for why this replaced the Seedream-keyframe + Seedance-video-edit pipeline)
 * — its own table, own lifecycle, deliberately NOT discovery_items. Every
 * submission is a new row (see migration 097), so the same reel can be
 * replicated for any number of different characters without one overwriting
 * another.
 */
import { one, query } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { resolveReelUrls, type ResolveError } from './enqueue-from-urls'
import { generateWanReferenceVideo } from './wan-reference'
import { probeSourceVideo } from './analyze'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import { enqueueRepurpose } from './process-item'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'

export interface WanJobRow {
  id: string
  user_id: string
  chat_id: string | null
  profile: string | null
  content_url: string
  content_id: string
  video_url: string | null
  reference_image_url: string
  aspect_ratio: string | null
  source_duration: string | number | null
  status: 'awaiting_confirm' | 'generating' | 'done' | 'failed'
  error: string | null
  video_result_url: string | null
  video_model: string | null
}

export interface CreateWanJobsResult {
  jobIds: string[]
  resolveErrors: ResolveError[]
  invalid: string[]
}

/**
 * Resolves the pasted reel link(s) to playable video URLs (same resolution
 * chain enqueueReelUrlsForUser uses) and creates one 'awaiting_confirm' row
 * per reel for this reference photo — no classify step, Wan 3.0 needs no
 * scene-description prompt.
 */
export async function createWanJobsFromUrls(opts: {
  userId: string
  chatId: string | number
  rawText: string
  referenceImageUrl: string
  username?: string | null
  sourceUsername?: string | null
}): Promise<CreateWanJobsResult> {
  const { reels, resolveErrors, invalid, username, sourceUsername } = await resolveReelUrls({
    userId: opts.userId,
    rawText: opts.rawText,
    username: opts.username,
    sourceUsername: opts.sourceUsername,
  })

  const jobIds: string[] = []
  for (const reel of reels) {
    if (!reel.videoUrl) continue
    const row = await one<{ id: string }>(
      `INSERT INTO copy_paste_wan_jobs
         (user_id, chat_id, profile, content_url, content_id, video_url, reference_image_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_confirm')
       RETURNING id`,
      [
        opts.userId, String(opts.chatId), sourceUsername ?? username,
        reel.permalink, reel.id, reel.videoUrl, opts.referenceImageUrl,
      ],
    )
    if (row) jobIds.push(row.id)
  }

  return { jobIds, resolveErrors, invalid }
}

/**
 * The paid call — only reached after a human taps Confirm (Telegram cpgo).
 * Idempotent on a re-run: an already-done job just returns its cached result.
 */
export async function runWanGeneration(
  jobId: string,
  userId: string,
  opts?: { repurposeCount?: number; outputDriveFolderId?: string | null },
): Promise<{ videoUrl: string }> {
  const job = await one<WanJobRow>(
    `SELECT * FROM copy_paste_wan_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  )
  if (!job) throw new Error('Job not found')
  if (job.status === 'done' && job.video_result_url) {
    return { videoUrl: job.video_result_url }
  }
  if (!job.video_url) throw new Error('Job has no source video')

  // Atomic claim: only the caller that actually flips awaiting_confirm ->
  // generating gets to fire the paid call. A second concurrent invocation
  // for the same job (e.g. a queue-job retry landing while the first attempt
  // is still genuinely running — see the cron/tick.ts exclusion this pipeline
  // needs) finds nothing to claim and fails loudly instead of billing Wan 3.0
  // twice. Confirmed live 2026-09-20: this is exactly how a job got generated
  // twice before that cron exclusion existed.
  const claimed = await one<{ id: string }>(
    `UPDATE copy_paste_wan_jobs SET status = 'generating'
      WHERE id = $1 AND status = 'awaiting_confirm'
      RETURNING id`,
    [jobId],
  )
  if (!claimed) {
    throw new Error(`Job already ${job.status} — not starting a second Wan 3.0 call for it`)
  }

  const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')

  try {
    let aspectRatio = job.aspect_ratio
    let duration = job.source_duration != null ? Number(job.source_duration) : null
    if (!aspectRatio || duration == null) {
      const probe = await probeSourceVideo(job.video_url, 5)
      if (probe) {
        aspectRatio = probe.aspectRatio === 'other' ? '9:16' : probe.aspectRatio
        duration = probe.duration
        await query(
          `UPDATE copy_paste_wan_jobs SET aspect_ratio = $2, source_duration = $3 WHERE id = $1`,
          [jobId, aspectRatio, duration],
        )
      }
    }
    // Conservative cap, not a measured one: the model documents total
    // input+output duration at <=30s but doesn't say exactly how the
    // reference video's own length counts against that, so this stays well
    // under it rather than risk a rejected/truncated call on a long source
    // clip. Can be relaxed once real output is seen.
    const wanDuration = Math.min(Math.max(Math.round(duration ?? 5), 2), 15)

    const result = await generateWanReferenceVideo({
      referenceImageUrl: job.reference_image_url,
      referenceVideoUrl: job.video_url,
      aspectRatio: aspectRatio ?? '9:16',
      duration: wanDuration,
    }, apiKey)

    await query(
      `UPDATE copy_paste_wan_jobs
          SET status = 'done', video_result_url = $2, video_model = $3, error = NULL
        WHERE id = $1`,
      [jobId, result.videoUrl, result.model],
    )

    await enqueueDriveArchive({
      userId,
      sourceType: 'queue_job',
      sourceId: jobId,
      urls: [result.videoUrl],
      characterKey: job.profile ?? undefined,
      kind: 'reels',
      stage: 'ready',
      modelKey: result.model,
    }).catch(err => console.error('[wan-jobs] drive archive failed:', err))

    await enqueueRepurpose({
      userId,
      videoUrl: result.videoUrl,
      count: opts?.repurposeCount ?? 0,
      characterKey: job.profile,
      itemId: jobId,
      outputDriveFolderId: opts?.outputDriveFolderId ?? null,
    }).catch(err => console.error('[wan-jobs] repurpose enqueue failed:', err))

    await notifyReplicationDone({
      userId,
      profile: job.profile ?? 'copy-paste',
      contentUrl: job.content_url,
      contentType: null,
      videoUrl: result.videoUrl,
      // Repurpose is already auto-applied above per the account's own
      // setting — offering the manual follow-up button too would double it.
      itemId: null,
    }).catch(() => {})

    return { videoUrl: result.videoUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(`UPDATE copy_paste_wan_jobs SET status = 'failed', error = $2 WHERE id = $1`, [jobId, msg])
    await notifyReplicationFailed(userId, job.profile ?? 'copy-paste', msg).catch(() => {})
    throw err
  }
}
