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
import { EnqueueUrlsError, resolveReelUrls, type ResolveError } from './enqueue-from-urls'
import { generateWanReferenceVideo, type WanReferenceInput } from './wan-reference'
import { buildMotionReference } from './wan-motion-reference'
import { probeSourceVideo } from './analyze'
import { videoHasAudio } from './video-audio'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import { enqueueRepurpose } from './process-item'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'
import { IGREPLICATOR_DRIVE_SECTION } from '@/lib/drive-archive/paths'
import { createHash, randomUUID } from 'node:crypto'
import { uploadBuffer, uploadImageFromUrl } from '@/lib/supabase-storage'
import { sendPhoto } from '@/lib/telegram'
import { splitDirectVideoUrls } from './telegram-batch'
import { KEYFRAME_IDENTITY_LOCK, PRESERVE_MOTION_CUE, REMOVE_ONSCREEN_TEXT } from './copy-paste-spec'
import { characterDriveKey, getCharacter } from '@/lib/content-ops/characters'
import { editImage as editImageSeedream, finalizeWithSkinEnhance } from '@/lib/wavespeed'
import type { CopyPasteWanPhase } from './wan-queue'

export interface WanJobRow {
  id: string
  user_id: string
  chat_id: string | null
  profile: string | null
  content_url: string
  content_id: string
  video_url: string | null
  reference_image_url: string
  character_id: string | null
  still_prompt: string | null
  still_image_url: string | null
  /** The reel as Wan gets it, person scrubbed (migration 105). */
  motion_video_url: string | null
  aspect_ratio: string | null
  source_duration: string | number | null
  status: WanJobStatus
  error: string | null
  video_result_url: string | null
  video_model: string | null
  origin: 'telegram' | 'sheet'
  error_code: WanErrorCode | null
  started_at: string | null
  completed_at: string | null
}

export type WanJobStatus =
  | 'queued' | 'acquiring'
  | 'awaiting_confirm' | 'still_generating' | 'awaiting_approval' | 'approved'
  | 'generating' | 'done' | 'failed' | 'cancelled'

/** Machine-readable failure reason stored next to the free-text `error` (migration 104). */
export type WanErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_JOB'
  | 'SOURCE_UNAVAILABLE'
  | 'ACQUISITION_FAILED'
  | 'STORAGE_FAILED'
  | 'REPLICATOR_UNAVAILABLE'
  | 'PROCESSING_FAILED'
  | 'STALLED'
  | 'UNKNOWN_ERROR'

/** A failure whose reason is already known where it is thrown. */
export class WanJobError extends Error {
  constructor(readonly code: WanErrorCode, message: string) {
    super(message)
  }
}

/** Reason for a failure in the still / Wan phases, read from the error it threw. */
export function classifyWanError(err: unknown): WanErrorCode {
  if (err instanceof WanJobError) return err.code
  const msg = err instanceof Error ? err.message : String(err)
  if (/Storage upload failed|SUPABASE_SERVICE_KEY/i.test(msg)) return 'STORAGE_FAILED'
  if (/No API key configured|\b401\b|unauthori[sz]ed/i.test(msg)) return 'REPLICATOR_UNAVAILABLE'
  return 'PROCESSING_FAILED'
}

/** Reason for a failed source resolution — which part broke decides what fixes it. */
export function classifyAcquireError(err: unknown): WanErrorCode {
  if (err instanceof WanJobError) return err.code
  if (err instanceof EnqueueUrlsError) {
    if (err.status === 400) return 'INVALID_INPUT'
    // A fetcher that is missing, erroring, or out of quota: retrying later can work.
    if (/No reel fetcher configured|Apify could not fetch it|out of requests|\b429\b/i.test(err.message)) {
      return 'ACQUISITION_FAILED'
    }
    // Every fetcher answered and none had the video: private, deleted, age-gated.
    return 'SOURCE_UNAVAILABLE'
  }
  return classifyWanError(err)
}

export interface CreateWanJobsResult {
  jobIds: string[]
  resolveErrors: ResolveError[]
  invalid: string[]
  /** Jobs whose source video has no audio track even after trying to re-join
   * one — Wan then invents its own speech, so the confirm step warns. */
  noAudioCount: number
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
  characterId?: string | null
  /** Additions to the scene still (character prompt + batch prompt); may be empty. */
  stillPrompt?: string | null
  username?: string | null
  sourceUsername?: string | null
}): Promise<CreateWanJobsResult> {
  // Uploaded clips / direct video links need no fetching; only Instagram links
  // go through the resolver (which rejects a text with no reel link in it).
  const { direct, rest } = splitDirectVideoUrls(opts.rawText)
  const empty = { reels: [], resolveErrors: [] as ResolveError[], invalid: [] as string[], username: null, sourceUsername: null }
  let resolved: Awaited<ReturnType<typeof resolveReelUrls>> | typeof empty = empty
  if (rest.trim()) {
    try {
      resolved = await resolveReelUrls({
        userId: opts.userId,
        rawText: rest,
        username: opts.username,
        sourceUsername: opts.sourceUsername,
      })
    } catch (err) {
      // The resolver throws when none of its links could be fetched. With
      // uploaded videos in the same batch that must not sink them too — the
      // unfetchable links are skipped and reported like any partial failure.
      if (!direct.length || !(err instanceof EnqueueUrlsError)) throw err
      resolved = {
        ...empty,
        resolveErrors: err.detail?.resolveErrors?.length
          ? err.detail.resolveErrors
          : [{ permalink: rest.trim(), error: err.message }],
        invalid: err.detail?.invalid ?? [],
      }
    }
  }
  const { resolveErrors, invalid, username, sourceUsername } = resolved
  const reels = [
    ...resolved.reels,
    ...direct.map(url => ({
      id: `upload-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
      permalink: url,
      videoUrl: url,
    })),
  ]

  const jobIds: string[] = []
  let noAudioCount = 0
  for (const reel of reels) {
    if (!reel.videoUrl) continue
    if ((await videoHasAudio(reel.videoUrl)) === false) noAudioCount++
    const row = await one<{ id: string }>(
      `INSERT INTO copy_paste_wan_jobs
         (user_id, chat_id, profile, content_url, content_id, video_url, reference_image_url, character_id, still_prompt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_confirm')
       RETURNING id`,
      [
        opts.userId, String(opts.chatId), sourceUsername ?? username,
        reel.permalink, reel.id, reel.videoUrl, opts.referenceImageUrl, opts.characterId ?? null,
        opts.stillPrompt?.trim() || null,
      ],
    )
    if (row) jobIds.push(row.id)
  }

  return { jobIds, resolveErrors, invalid, noAudioCount }
}

/**
 * The paid call — only reached after a human taps Confirm (Telegram cpgo).
 * Idempotent on a re-run: an already-done job just returns its cached result.
 */
/**
 * The Seedream scene still, as the old Copy-Paste keyframe did it: image 1 is a
 * frame of the source reel (pose, framing, background), image 2 the character's
 * reference photo (identity). The user's prompt only adds to that edit (props,
 * wardrobe, body) — it is appended to the fixed swap instructions, never a
 * replacement for them.
 */
export function renderWanStillPrompt(additions: string | null | undefined): string {
  return [
    'Image 1 is the scene reference, image 2 is the identity reference.',
    'Keep the exact pose, camera framing, and background from image 1 unchanged.',
    "Replace the main subject's face and body identity with the person from image 2.",
    `Body and skin come from image 2, not image 1: ${KEYFRAME_IDENTITY_LOCK}.`,
    PRESERVE_MOTION_CUE,
    REMOVE_ONSCREEN_TEXT,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
    additions?.trim(),
  ].filter(Boolean).join(' ')
}

/** Blurred frames compress smaller, so the largest sampled JPEG is the sharpest. */
export function sharpestFrameIndex(framesBase64: readonly string[]): number {
  let best = 0
  for (let i = 1; i < framesBase64.length; i++) {
    if (framesBase64[i].length > framesBase64[best].length) best = i
  }
  return best
}

/**
 * Seedream v5 Pro Edit of [source frame, reference photo], then the Z-Image
 * Turbo skin pass — same still workflow as the recreate bot. It goes to Wan next
 * to the original photo, never instead of it. Any failure here fails the job
 * before the paid Wan call.
 */
async function generateSceneStill(opts: {
  jobId: string
  referenceImageUrl: string
  sceneFrameBase64: string
  additions: string | null
  aspectRatio: string
  apiKey: string
}): Promise<string> {
  const frameUrl = await uploadBuffer(
    Buffer.from(opts.sceneFrameBase64, 'base64'),
    `monitor/${opts.jobId}/wan-scene-frame.jpg`,
    'image/jpeg',
  )
  const outputs = await editImageSeedream({
    imageUrls: [frameUrl, opts.referenceImageUrl],
    prompt: renderWanStillPrompt(opts.additions),
    size: opts.aspectRatio,
    apiKey: opts.apiKey,
  })
  if (!outputs.length) throw new Error('Seedream returned no image for the scene still')
  const finalUrl = await finalizeWithSkinEnhance(outputs[0], opts.aspectRatio, opts.apiKey)
  // Re-hosted: WaveSpeed result links are not guaranteed to outlive the Wan job.
  // A fresh name per still: Regenerate used to overwrite one URL, and a cached
  // copy of the rejected still could then be what Wan fetched after Approve.
  return await uploadImageFromUrl(finalUrl, `monitor/${opts.jobId}/wan-still-${randomUUID().slice(0, 8)}.jpg`)
    .catch(() => finalUrl)
}

/**
 * The job's scrubbed reel (wan-motion-reference.ts), built once per source and
 * kept on the row; Regenerate reuses it. Throws instead of falling back to the
 * raw reel — that fallback is exactly how the source person reached Wan.
 */
async function ensureMotionReference(
  job: Pick<WanJobRow, 'id' | 'video_url' | 'motion_video_url'>,
  apiKey: string,
): Promise<string> {
  if (job.motion_video_url) return job.motion_video_url
  if (!job.video_url) throw new Error('Job has no source video')
  const url = await buildMotionReference({ jobId: job.id, sourceVideoUrl: job.video_url, apiKey })
  await query(`UPDATE copy_paste_wan_jobs SET motion_video_url = $2, updated_at = now() WHERE id = $1`, [job.id, url])
  return url
}

/**
 * Exactly what Wan 3.0 gets for a job: Image 1 the character's photo, Image 2
 * the approved still, Video 1 the scrubbed reel — the raw reel never.
 */
export function wanReferenceInput(
  job: Pick<WanJobRow, 'reference_image_url' | 'still_image_url' | 'motion_video_url' | 'video_url' | 'aspect_ratio' | 'source_duration'>,
): WanReferenceInput {
  if (!job.still_image_url) throw new Error('Job has no approved still')
  if (!job.motion_video_url || job.motion_video_url === job.video_url) {
    throw new Error('Job has no scrubbed motion reference — not sending the raw reel to Wan 3.0')
  }
  const duration = job.source_duration != null ? Number(job.source_duration) : null
  return {
    referenceImageUrls: [job.reference_image_url, job.still_image_url],
    motionVideoUrl: job.motion_video_url,
    aspectRatio: job.aspect_ratio ?? '9:16',
    // Conservative cap, not a measured one: the model documents total
    // input+output duration at <=30s but doesn't say exactly how the
    // reference video's own length counts against that, so this stays well
    // under it rather than risk a rejected/truncated call on a long source
    // clip. Can be relaxed once real output is seen.
    duration: Math.min(Math.max(Math.round(duration ?? 5), 2), 15),
  }
}

/** Buttons under a still waiting for approval; data is `<action>:<wan job id>`. */
export function stillApprovalKeyboard(jobId: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `wanok:${jobId}` },
      { text: '🔁 Regenerate', callback_data: `wanre:${jobId}` },
      { text: '✖️ Cancel', callback_data: `wanno:${jobId}` },
    ]],
  }
}

/**
 * Phase 1 after Confirm: the Seedream + Z-Image scene still, sent to Telegram
 * for approval. Nothing paid for Wan happens here; runWanGeneration only runs
 * once the still is approved. Also serves Regenerate (the job is put back to
 * awaiting_confirm and this runs again, replacing the still).
 */
// Re-entering still_generating is deliberate: a crashed worker's queue retry
// must be able to finish it. Nothing paid for Wan happens in this phase.
export async function prepareWanStill(jobId: string, userId: string): Promise<{ stillUrl: string }> {
  const job = await one<WanJobRow>(
    `UPDATE copy_paste_wan_jobs SET status = 'still_generating', error = NULL
      WHERE id = $1 AND user_id = $2 AND status IN ('awaiting_confirm', 'still_generating')
      RETURNING *`,
    [jobId, userId],
  )
  if (!job) throw new Error('Job is not waiting for a still — already handled')
  if (!job.video_url) throw new Error('Job has no source video')

  try {
    const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')
    const probe = await probeSourceVideo(job.video_url, 5)
    if (!probe?.frames.length) throw new Error('Could not read frames from the source reel for the scene still')
    const aspectRatio = job.aspect_ratio ?? (probe.aspectRatio === 'other' ? '9:16' : probe.aspectRatio)
    const duration = job.source_duration != null ? Number(job.source_duration) : probe.duration

    // The motion reference is built here, beside the still, so a failure shows
    // before Approve and the paid video phase does not wait on it.
    const [stillUrl] = await Promise.all([
      generateSceneStill({
        jobId,
        referenceImageUrl: job.reference_image_url,
        sceneFrameBase64: probe.frames[sharpestFrameIndex(probe.frames)],
        additions: job.still_prompt,
        aspectRatio,
        apiKey,
      }),
      ensureMotionReference(job, apiKey),
    ])
    await query(
      `UPDATE copy_paste_wan_jobs
          SET status = 'awaiting_approval', still_image_url = $2, aspect_ratio = $3, source_duration = $4
        WHERE id = $1`,
      [jobId, stillUrl, aspectRatio, duration],
    )

    if (job.chat_id) {
      await sendPhoto(
        job.chat_id,
        stillUrl,
        [
          '🖼 <b>Scene still</b> — approve to start the paid Wan 3.0 video.',
          job.content_url ? `Source: ${escapeHtml(job.content_url)}` : '',
          job.still_prompt ? `Additions: ${escapeHtml(job.still_prompt.slice(0, 300))}` : '',
        ].filter(Boolean).join('\n'),
        stillApprovalKeyboard(jobId),
      )
    }
    return { stillUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = classifyWanError(err)
    await markWanJobFailed(jobId, code, msg)
    console.error(`[wan-jobs] job ${jobId} still failed [${code}]: ${msg}`)
    await notifyReplicationFailed(userId, job.profile ?? 'copy-paste', `Scene still: ${msg}`).catch(() => {})
    throw err
  }
}

export async function markWanJobFailed(jobId: string, code: WanErrorCode, msg: string): Promise<void> {
  await query(
    `UPDATE copy_paste_wan_jobs
        SET status = 'failed', error = $2, error_code = $3, completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [jobId, msg, code],
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

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

  // Atomic claim: only the caller that actually flips approved ->
  // generating gets to fire the paid call — and only after a human approved
  // the scene still in Telegram (prepareWanStill). A second concurrent invocation
  // for the same job (e.g. a queue-job retry landing while the first attempt
  // is still genuinely running — see the cron/tick.ts exclusion this pipeline
  // needs) finds nothing to claim and fails loudly instead of billing Wan 3.0
  // twice. Confirmed live 2026-09-20: this is exactly how a job got generated
  // twice before that cron exclusion existed.
  const claimed = await one<{ id: string }>(
    `UPDATE copy_paste_wan_jobs SET status = 'generating'
      WHERE id = $1 AND status = 'approved' AND still_image_url IS NOT NULL
      RETURNING id`,
    [jobId],
  )
  if (!claimed) {
    throw new Error(`Job already ${job.status} — not starting a second Wan 3.0 call for it`)
  }

  const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')

  try {
    // Aspect ratio and duration were recorded by prepareWanStill's probe, and
    // normally the motion reference too; a job stilled before migration 105
    // gets its motion reference here.
    const motionVideoUrl = await ensureMotionReference(job, apiKey)
    const result = await generateWanReferenceVideo(
      wanReferenceInput({ ...job, motion_video_url: motionVideoUrl }),
      apiKey,
    )

    // Re-hosted rather than used as-is: WaveSpeed's own CloudFront result
    // link isn't reliably fetchable by Telegram's own URL-fetch for sendVideo
    // (confirmed live 2026-09-20 — "Bad Request: failed to get HTTP URL
    // content" on a perfectly valid, finished video) and there's no
    // guarantee how long that link stays valid. Falls back to the original
    // WaveSpeed URL if the re-host itself fails, same as the recreate bot's
    // finishSeedanceRender does.
    const hostedVideoUrl = await uploadImageFromUrl(
      result.videoUrl,
      `monitor/${jobId}/wan-result.mp4`,
    ).catch(() => result.videoUrl)

    await query(
      `UPDATE copy_paste_wan_jobs
          SET status = 'done', video_result_url = $2, video_model = $3, error = NULL, error_code = NULL,
              completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [jobId, hostedVideoUrl, result.model],
    )

    // With a character, the unedited Wan output lands in <character>/reels/raw/
    // — the folder the farm polls and repurposes per device. Without one, the
    // old behaviour: filed under the source account.
    const character = job.character_id ? await getCharacter(userId, job.character_id) : null
    const characterKey = character ? characterDriveKey(character.name) : job.profile

    // Neutral file name (date + job), no model name in it; all Replicator
    // output sits under XXMachine Archives/IGreplicator/<character>/.
    const archiveLabel = `${new Date().toISOString().slice(0, 10)}_${jobId.slice(0, 8)}`
    await enqueueDriveArchive({
      userId,
      sourceType: 'queue_job',
      sourceId: jobId,
      urls: [hostedVideoUrl],
      characterKey: characterKey ?? undefined,
      kind: 'reels',
      stage: character ? 'raw' : 'ready',
      modelKey: result.model,
      seriesLabel: archiveLabel,
      section: IGREPLICATOR_DRIVE_SECTION,
    }).catch(err => console.error('[wan-jobs] drive archive failed:', err))

    await enqueueRepurpose({
      userId,
      videoUrl: hostedVideoUrl,
      count: opts?.repurposeCount ?? 0,
      characterKey,
      itemId: jobId,
      seriesLabel: archiveLabel,
      driveSection: IGREPLICATOR_DRIVE_SECTION,
      outputDriveFolderId: opts?.outputDriveFolderId ?? null,
    }).catch(err => console.error('[wan-jobs] repurpose enqueue failed:', err))

    await notifyReplicationDone({
      userId,
      profile: job.profile ?? 'copy-paste',
      contentUrl: job.content_url,
      contentType: null,
      videoUrl: hostedVideoUrl,
      // Repurpose is already auto-applied above per the account's own
      // setting — offering the manual follow-up button too would double it.
      itemId: null,
    }).catch(err => console.error('[wan-jobs] notify failed:', err))

    return { videoUrl: hostedVideoUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = classifyWanError(err)
    await markWanJobFailed(jobId, code, msg)
    console.error(`[wan-jobs] job ${jobId} Wan failed [${code}]: ${msg}`)
    await notifyReplicationFailed(userId, job.profile ?? 'copy-paste', msg).catch(() => {})
    throw err
  }
}

// ── Viral monitoring Sheet bridge (viral-sheet.ts) ─────────────────────────

export interface CreateSheetWanJobResult {
  jobId: string
  /** false: the same reel + character was already live — jobId is that job. */
  created: boolean
  status: WanJobStatus
}

/**
 * One ticked Sheet row → one 'queued' job. Resolving the reel happens later in
 * the queue (acquireWanJobSource), so the Sheet gets its Job ID within one tick.
 * The partial unique index from migration 104 is the duplicate guard: two ticks
 * racing on the same row, or two rows with the same reel + character, end up
 * with one job.
 */
export async function createSheetWanJob(opts: {
  userId: string
  chatId: string | number | null
  shortCode: string
  permalink: string
  /** The Sheet's "Nalog" — lets the resolver fall back to listing that profile. */
  sourceUsername: string | null
  characterId: string
  referenceImageUrl: string
  stillPrompt: string | null
}): Promise<CreateSheetWanJobResult> {
  const inserted = await one<{ id: string }>(
    `INSERT INTO copy_paste_wan_jobs
       (user_id, chat_id, profile, content_url, content_id, reference_image_url, character_id, still_prompt, status, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued','sheet')
     ON CONFLICT (user_id, lower(content_id), character_id)
       WHERE origin = 'sheet' AND status NOT IN ('failed', 'cancelled')
     DO NOTHING
     RETURNING id`,
    [
      opts.userId, opts.chatId != null ? String(opts.chatId) : null, opts.sourceUsername,
      opts.permalink, opts.shortCode, opts.referenceImageUrl, opts.characterId,
      opts.stillPrompt?.trim() || null,
    ],
  )
  if (inserted) {
    console.log(`[wan-jobs] sheet job ${inserted.id} queued for ${opts.permalink} (character ${opts.characterId})`)
    return { jobId: inserted.id, created: true, status: 'queued' }
  }

  const existing = await one<{ id: string; status: WanJobStatus }>(
    `SELECT id, status FROM copy_paste_wan_jobs
      WHERE user_id = $1 AND lower(content_id) = lower($2) AND character_id = $3
        AND origin = 'sheet' AND status NOT IN ('failed', 'cancelled')
      LIMIT 1`,
    [opts.userId, opts.shortCode, opts.characterId],
  )
  // Only possible if the conflicting job failed in the instant between the two
  // statements; the row stays ticked, so the next tick simply tries again.
  if (!existing) throw new Error('Conflicting job disappeared before it could be read — will retry next tick')
  return { jobId: existing.id, created: false, status: existing.status }
}

/**
 * The acquire phase of a Sheet job: resolve the reel through the same chain the
 * Telegram batch uses, then keep our own copy — an Instagram CDN link can expire
 * while the scene still waits hours for approval. Leaves the job at
 * 'awaiting_confirm', which is exactly what prepareWanStill claims next.
 */
// Re-entering 'acquiring' is deliberate, same as still_generating: a crashed
// worker's queue retry must be able to finish it. Nothing here is billed.
export async function acquireWanJobSource(jobId: string, userId: string): Promise<{ videoUrl: string }> {
  const job = await one<WanJobRow>(
    `UPDATE copy_paste_wan_jobs
        SET status = 'acquiring', started_at = COALESCE(started_at, now()),
            error = NULL, error_code = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'acquiring')
      RETURNING *`,
    [jobId, userId],
  )
  if (!job) throw new Error('Job is not waiting for its source — already handled')
  console.log(`[wan-jobs] job ${jobId} acquiring ${job.content_url}`)

  try {
    let sourceUrl: string | null | undefined
    try {
      const resolved = await resolveReelUrls({ userId, rawText: job.content_url, sourceUsername: job.profile })
      sourceUrl = resolved.reels[0]?.videoUrl
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new WanJobError(err instanceof EnqueueUrlsError ? classifyAcquireError(err) : 'ACQUISITION_FAILED', msg)
    }
    if (!sourceUrl) throw new WanJobError('SOURCE_UNAVAILABLE', 'No playable video URL for this reel')

    // Already on our storage (e.g. an audio re-join) — copying it again gains nothing.
    let videoUrl = sourceUrl
    const ownStorage = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/storage/v1/object/public/` : null
    if (!ownStorage || !sourceUrl.startsWith(ownStorage)) {
      try {
        videoUrl = await uploadImageFromUrl(sourceUrl, `monitor/${jobId}/source.mp4`)
      } catch (err) {
        throw new WanJobError('STORAGE_FAILED', `Could not store the source video: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await query(
      `UPDATE copy_paste_wan_jobs SET status = 'awaiting_confirm', video_url = $2, updated_at = now()
        WHERE id = $1 AND status = 'acquiring'`,
      [jobId, videoUrl],
    )
    console.log(`[wan-jobs] job ${jobId} source stored: ${videoUrl}`)
    return { videoUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = classifyAcquireError(err)
    await markWanJobFailed(jobId, code, msg)
    console.error(`[wan-jobs] job ${jobId} acquire failed [${code}]: ${msg}`)
    await notifyReplicationFailed(userId, job.profile ?? 'copy-paste', `Source: ${msg}`).catch(() => {})
    throw err
  }
}

/**
 * Explicit retry of a failed/cancelled Sheet job — the same row starts over from
 * 'queued' (the old source link may have expired, so it is resolved again).
 * 'duplicate': meanwhile another row started the same reel + character.
 */
export async function retrySheetWanJob(
  jobId: string,
  userId: string,
): Promise<'retried' | 'duplicate' | 'not_retryable'> {
  try {
    const row = await one<{ id: string }>(
      `UPDATE copy_paste_wan_jobs
          SET status = 'queued', error = NULL, error_code = NULL,
              video_url = NULL, still_image_url = NULL, motion_video_url = NULL, video_result_url = NULL, video_model = NULL,
              aspect_ratio = NULL, source_duration = NULL,
              started_at = NULL, completed_at = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND origin = 'sheet' AND status IN ('failed', 'cancelled')
        RETURNING id`,
      [jobId, userId],
    )
    if (row) console.log(`[wan-jobs] sheet job ${jobId} retried`)
    return row ? 'retried' : 'not_retryable'
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return 'duplicate'
    throw err
  }
}

/** Item states a copy_paste_wan queue job of each phase is responsible for moving on. */
const PHASE_ITEM_STATUSES: Record<CopyPasteWanPhase, WanJobStatus[]> = {
  acquire: ['queued', 'acquiring', 'awaiting_confirm', 'still_generating'],
  still: ['awaiting_confirm', 'still_generating'],
  video: ['approved', 'generating'],
}

/**
 * cron/tick fails a stalled copy_paste_wan queue job; this fails the items it
 * left mid-phase, which otherwise sit in e.g. 'generating' forever. Items a
 * newer, still-live queue job has picked up (a Regenerate) are left alone.
 */
export async function failStaleWanItems(queueJobId: string, message: string): Promise<number> {
  const q = await one<{ input: { jobIds?: string[]; phase?: CopyPasteWanPhase } | null }>(
    `SELECT input FROM generation_queue WHERE id = $1`,
    [queueJobId],
  )
  const jobIds = q?.input?.jobIds ?? []
  if (!jobIds.length) return 0
  const statuses = PHASE_ITEM_STATUSES[q?.input?.phase ?? 'video']
  const res = await query(
    `UPDATE copy_paste_wan_jobs cpw
        SET status = 'failed', error = $2, error_code = 'STALLED', completed_at = now(), updated_at = now()
      WHERE cpw.id = ANY($1::uuid[])
        AND cpw.status = ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1 FROM generation_queue g
           WHERE g.id <> $4 AND g.job_type = 'copy_paste_wan'
             AND g.status IN ('pending', 'processing')
             AND g.input->'jobIds' ? cpw.id::text
        )`,
    [jobIds, message, statuses, queueJobId],
  )
  const n = res.rowCount ?? 0
  if (n) console.error(`[wan-jobs] queue job ${queueJobId} stalled — failed ${n} item(s)`)
  return n
}
