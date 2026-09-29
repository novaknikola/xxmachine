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
import { videoHasAudio } from './video-audio'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import { enqueueRepurpose } from './process-item'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'
import { createHash } from 'node:crypto'
import { uploadBuffer, uploadImageFromUrl } from '@/lib/supabase-storage'
import { splitDirectVideoUrls } from './telegram-batch'
import { KEYFRAME_IDENTITY_LOCK, PRESERVE_MOTION_CUE, REMOVE_ONSCREEN_TEXT } from './copy-paste-spec'
import { characterDriveKey, getCharacter } from '@/lib/content-ops/characters'
import { editImage as editImageSeedream, finalizeWithSkinEnhance } from '@/lib/wavespeed'

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
  const resolved = rest.trim()
    ? await resolveReelUrls({
        userId: opts.userId,
        rawText: rest,
        username: opts.username,
        sourceUsername: opts.sourceUsername,
      })
    : { reels: [], resolveErrors: [], invalid: [], username: null, sourceUsername: null }
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
  return await uploadImageFromUrl(finalUrl, `monitor/${opts.jobId}/wan-still.jpg`).catch(() => finalUrl)
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
    // Always probed now: the scene still needs a frame of the source reel.
    const probe = await probeSourceVideo(job.video_url, 5)
    if (!probe?.frames.length) throw new Error('Could not read frames from the source reel for the scene still')
    if (!aspectRatio || duration == null) {
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

    const stillUrl = await generateSceneStill({
      jobId,
      referenceImageUrl: job.reference_image_url,
      sceneFrameBase64: probe.frames[sharpestFrameIndex(probe.frames)],
      additions: job.still_prompt,
      aspectRatio: aspectRatio ?? '9:16',
      apiKey,
    })
    await query(`UPDATE copy_paste_wan_jobs SET still_image_url = $2 WHERE id = $1`, [jobId, stillUrl])
    const referenceImageUrls = [job.reference_image_url, stillUrl]

    const result = await generateWanReferenceVideo({
      referenceImageUrls,
      referenceVideoUrl: job.video_url,
      aspectRatio: aspectRatio ?? '9:16',
      duration: wanDuration,
    }, apiKey)

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
          SET status = 'done', video_result_url = $2, video_model = $3, error = NULL
        WHERE id = $1`,
      [jobId, hostedVideoUrl, result.model],
    )

    // With a character, the unedited Wan output lands in <character>/reels/raw/
    // — the folder the farm polls and repurposes per device. Without one, the
    // old behaviour: filed under the source account.
    const character = job.character_id ? await getCharacter(userId, job.character_id) : null
    const characterKey = character ? characterDriveKey(character.name) : job.profile

    await enqueueDriveArchive({
      userId,
      sourceType: 'queue_job',
      sourceId: jobId,
      urls: [hostedVideoUrl],
      characterKey: characterKey ?? undefined,
      kind: 'reels',
      stage: character ? 'raw' : 'ready',
      modelKey: result.model,
    }).catch(err => console.error('[wan-jobs] drive archive failed:', err))

    await enqueueRepurpose({
      userId,
      videoUrl: hostedVideoUrl,
      count: opts?.repurposeCount ?? 0,
      characterKey,
      itemId: jobId,
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
    await query(`UPDATE copy_paste_wan_jobs SET status = 'failed', error = $2 WHERE id = $1`, [jobId, msg])
    await notifyReplicationFailed(userId, job.profile ?? 'copy-paste', msg).catch(() => {})
    throw err
  }
}
