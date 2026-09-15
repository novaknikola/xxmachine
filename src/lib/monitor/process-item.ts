import { one, query, rows } from '@/lib/db'
import { copyPasteArchiveLabel } from '@/lib/drive-archive/label'
import {
  extractCopyPasteSpec,
  transcribeSourceSpeech,
  normalizeCopyPasteSpec,
  renderCopyPastePrompt,
  renderEndKeyframeEditPrompt,
  renderKeyframeEditPrompt,
  type CopyPasteSpec,
} from './copy-paste-spec'
import { probeSourceVideo, uploadFaceFrame, type SourceAspectRatio } from './analyze'
import { generateCopyPasteKeyframe, generateSeedanceVideo } from './replicate'
import { getUserApiKey } from '@/lib/user-config'
import { notifyReplicationDone, notifyReplicationFailed, notifyKeyframeReady } from './notify'
import { archiveDiscoveryItem } from '@/lib/drive-archive/from-discovery-item'
import type { DiscoveryItemRow, EndFrameMode, TrackedProfileRow } from './types'
import { resolveVideoUrlViaRapidApi, resolveVideoUrlsViaApify } from '@/lib/instagram-scrape'
import { resolveKey } from '@/lib/user-keys'
import { isPlayableVideoUrl } from './video-url'
import { internalBaseUrl } from '@/lib/internal-url'
import { IGREPLICATOR_REPURPOSE_RANGES } from '@/lib/video-effect-ranges'

/**
 * Floor for frames sampled per clip — denser sampling catches background gag
 * beats. probeSourceVideo raises this on longer clips to hold the gap between
 * frames roughly constant, so this only binds for short reels.
 */
const PROBE_FRAME_COUNT = 8

/**
 * Fan a finished video out into N repurposed variants, archived to Drive.
 * Enqueued rather than run inline: ffmpeg on N variants is minutes of work and
 * belongs on the queue, not inside an already-long replicate call. Failure here
 * must never fail the replicate that produced the video, so callers catch.
 */
async function enqueueRepurpose(opts: {
  userId: string
  videoUrl: string
  count: number
  characterKey: string | null
  itemId: string
  /** Derived from the source reel so variants share the original's prefix. */
  seriesLabel?: string
  /** Override destination. Empty keeps the computed archive tree. */
  outputDriveFolderId?: string | null
}): Promise<void> {
  if (!opts.count || opts.count < 1) return

  const job = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'video_repurpose', $2, $3)
     RETURNING id`,
    [
      opts.userId,
      JSON.stringify({
        videoUrl: opts.videoUrl,
        videoName: `${opts.itemId.slice(0, 8)}.mp4`,
        count: opts.count,
        baseSeed: Math.floor(Math.random() * 0xffffff),
        // Everything on: the point is maximum spread between variants.
        effects: {
          brightness: true, contrast: true, saturation: true,
          hue: true, speed: true, flipH: true, crop: true, fade: false,
        },
        // Color grading capped at ~3% — the defaults were too strong for this
        // pipeline's output. Fixed 35% sharpen and a half-second head trim
        // added on top.
        effectRanges: IGREPLICATOR_REPURPOSE_RANGES,
        sharpen: true,
        trimStartSec: 0.5,
        archiveToDrive: true,
        characterKey: opts.characterKey,
        seriesLabel: opts.seriesLabel,
        outputDriveFolderId: opts.outputDriveFolderId ?? null,
      }),
      opts.count,
    ],
  )
  if (!job) return

  const secret = process.env.CRON_SECRET
  if (!secret) return   // cron will pick it up on the next tick
  const claimed = await one<{ id: string }>(
    `UPDATE generation_queue
        SET status = 'processing', started_at = now(), attempts = attempts + 1
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [job.id],
  ).catch(() => null)
  if (!claimed) return
  fetch(`${internalBaseUrl()}/api/queue/process/${job.id}`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  }).catch(err => console.error('[monitor/replicate] fire repurpose worker:', err))
}

/**
 * Re-resolves one reel's video URL directly from Instagram, bypassing
 * whatever is cached on the row. Instagram's CDN links are signed and expire
 * (observed ~34h lifetime on a real URL) — a link cached days or weeks ago
 * 403s by the time this item is (re-)analyzed. Mirrors the same Apify →
 * RapidAPI fallback chain enqueueReelUrlsForUser uses to resolve a link the
 * first time, so classifyDiscoveryItem can self-heal a dead cached link
 * instead of failing outright the first time that happens.
 */
async function reresolveVideoUrl(opts: {
  userId: string
  shortCode: string
  permalink: string
}): Promise<string | null> {
  if (process.env.APIFY_API_KEY) {
    try {
      const byCode = await resolveVideoUrlsViaApify([opts.permalink])
      const match = byCode.get(opts.shortCode.toLowerCase())
      if (match?.videoUrl && isPlayableVideoUrl(match.videoUrl)) return match.videoUrl
    } catch {
      /* fall through to RapidAPI */
    }
  }

  const rapidApiKey = await resolveKey(opts.userId, 'RAPIDAPI_KEY')
  if (rapidApiKey) {
    try {
      const r = await resolveVideoUrlViaRapidApi(opts.permalink, rapidApiKey)
      if (isPlayableVideoUrl(r.videoUrl)) return r.videoUrl
    } catch {
      /* nothing left to try */
    }
  }

  return null
}

/**
 * Analysis-only step: probes the source clip and produces the CopyPasteSpec +
 * rendered prompt so they can be reviewed/edited before paying for a Seedance call.
 * Requires a source video — Copy-Paste has no still-image path.
 */
/**
 * Re-runs the vision analysis over the source video and rewrites the spec.
 *
 * `reset` additionally clears the finished render. Without it, re-analyzing a
 * `done` item changes nothing a viewer can see: replicateCopyPasteItem returns
 * early on an existing kling_video_url, so the new spec never reaches Seedance.
 * The finished video is not lost — Drive archiving has already copied it.
 */
export async function classifyDiscoveryItem(
  itemId: string,
  userId: string,
  opts?: { reset?: boolean },
) {
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (!item.video_url) throw new Error('Item has no source video to analyze')

  await query(
    `UPDATE discovery_items SET replicate_status = 'analyzing', replicate_error = NULL WHERE id = $1`,
    [itemId],
  )

  try {
    let videoUrl = item.video_url
    // Transcript first: its line times decide where extra frames go, so that
    // speech attribution has a frame at the moment each line was spoken.
    let transcript = await transcribeSourceSpeech(videoUrl)
    let probe = await probeSourceVideo(videoUrl, PROBE_FRAME_COUNT, transcript.lineTimes)

    // A cached CDN link can go stale between when it was first resolved and
    // when this item is (re-)analyzed. Re-resolve once from Instagram before
    // giving up, instead of failing an otherwise-fine reel over a dead link
    // left over from an earlier attempt — see reresolveVideoUrl.
    if (!probe) {
      const fresh = await reresolveVideoUrl({
        userId,
        shortCode: item.content_id,
        permalink: item.content_url,
      })
      if (fresh && fresh !== videoUrl) {
        videoUrl = fresh
        await query(`UPDATE discovery_items SET video_url = $2 WHERE id = $1`, [itemId, videoUrl])
        transcript = await transcribeSourceSpeech(videoUrl)
        probe = await probeSourceVideo(videoUrl, PROBE_FRAME_COUNT, transcript.lineTimes)
      }
    }
    if (!probe) throw new Error('Could not read source video')

    const spec = await extractCopyPasteSpec(probe, videoUrl, transcript)
    const renderedPrompt = renderCopyPastePrompt(spec)
    // Picks the frame where the face actually reads well, per the analysis above
    // (spec.best_face_frame_time) — replaces the old blind "always frame 0".
    const faceFrameUrl = await uploadFaceFrame(probe, spec.best_face_frame_time)

    // A prompt the user typed outlives a re-analysis. They can take the new one
    // by clearing the textarea, which also clears this flag.
    const promptKept = item.prompt_edited_at !== null && item.prompt_edited_at !== undefined
    const reset = opts?.reset === true

    await query(
      `UPDATE discovery_items
          SET content_type = 'video_gen',
              copy_paste_spec = $2::jsonb,
              rendered_prompt = CASE WHEN $11::bool THEN rendered_prompt ELSE $3 END,
              source_duration = $4,
              source_cut_count = $5,
              source_aspect_ratio = $6,
              source_width = $7,
              source_height = $8,
              source_first_frame_url = coalesce($9, source_first_frame_url),
              source_last_frame_url = coalesce($10, source_last_frame_url),
              replicate_status = 'classified',
              replicate_error = NULL,
              -- reset only: the keyframes and their prompts are a composite of the
              -- source frame and the identity photo, and the hook is deliberately
              -- kept out of them — so a plain re-analysis does not invalidate them
              -- and there is no reason to re-spend on Seedream.
              kling_video_url        = CASE WHEN $12::bool THEN NULL ELSE kling_video_url END,
              video_model            = CASE WHEN $12::bool THEN NULL ELSE video_model END,
              generated_image_url    = CASE WHEN $12::bool THEN NULL ELSE generated_image_url END,
              generated_end_image_url= CASE WHEN $12::bool THEN NULL ELSE generated_end_image_url END,
              keyframe_prompt        = CASE WHEN $12::bool THEN NULL ELSE keyframe_prompt END,
              end_keyframe_prompt    = CASE WHEN $12::bool THEN NULL ELSE end_keyframe_prompt END
        WHERE id = $1`,
      [
        itemId,
        JSON.stringify(spec),
        renderedPrompt,
        probe.duration,
        probe.cutCount,
        probe.aspectRatio,
        probe.width,
        probe.height,
        faceFrameUrl,
        // Without this the end-frame variant silently never fires: Replicate
        // skips its probe when a spec already exists, so the only chance to
        // capture the last frame is here.
        probe.lastFrameUrl,
        promptKept,
        reset,
      ],
    )

    return { content_type: 'video_gen' as const, spec, renderedPrompt, promptKept, reset }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    throw err
  }
}

/**
 * Phase 1 of replication: reference photo + source face-frame composited into
 * a Seedream v5 Pro Edit keyframe (start, and optionally a matching end
 * keyframe). Stops there and parks the item on 'awaiting_keyframe_approval'
 * instead of continuing straight to Seedance — the keyframe is the only real
 * check on whether the identity swap looks right before paying for the
 * video-edit call, which runs up to 45 minutes and cannot be undone once
 * billed. finishCopyPasteVideo() below does the rest once a human approves,
 * from either the Run tab or the Telegram notification this sends.
 */
export async function generateCopyPasteKeyframes(
  itemId: string,
  userId: string,
  opts?: {
    endFrame?: EndFrameMode
    /** Appended to the keyframe (Seedream) edit prompt — the video-edit (Seedance) prompt is
     *  fixed and does not read this. See finishCopyPasteVideo's finalPrompt for why. */
    customPrompt?: string | null
  },
) {
  const endFrameMode: EndFrameMode = opts?.endFrame ?? 'auto'
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (item.admin_status !== 'APPROVED') throw new Error('Item must be approved before replication')
  if (!item.video_url) throw new Error('Item has no source video')

  const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')

  // Items that came from a profile scan were never part of a manual paste, so
  // they carry no per-batch photo. Fall back to the account default before
  // failing, otherwise the whole scan → approve → replicate loop is unusable.
  let referenceImageUrl = item.reference_image_url
  if (!referenceImageUrl) {
    const defaults = await one<{ default_reference_image_url: string | null }>(
      `SELECT default_reference_image_url FROM users WHERE id = $1`,
      [userId],
    )
    referenceImageUrl = defaults?.default_reference_image_url ?? null
  }
  if (!referenceImageUrl) {
    throw new Error('No reference photo — upload one with the batch, or set a default in Settings')
  }

  // Idempotent: a requeued/retried job must not pay for a second Seedance render.
  if (item.kling_video_url) {
    await query(
      `UPDATE discovery_items SET replicate_status = 'done', replicate_error = NULL WHERE id = $1`,
      [itemId],
    )
    return { ok: true, videoUrl: item.kling_video_url, model: item.video_model ?? 'cached', awaitingApproval: false }
  }
  // Keyframes are already sitting in front of a human — a re-poll of the same
  // batch (queue retries a batch by item, not by call) must not regenerate
  // them (paid) or re-send the same Telegram notification.
  if (item.replicate_status === 'awaiting_keyframe_approval' && item.generated_image_url) {
    return { ok: true, awaitingApproval: true }
  }

  try {
    let spec: CopyPasteSpec | null = item.copy_paste_spec
      ? normalizeCopyPasteSpec(item.copy_paste_spec)
      : null
    let aspectRatio: SourceAspectRatio = item.source_aspect_ratio ?? 'other'
    let firstFrameUrl = item.source_first_frame_url
    let lastFrameUrl = item.source_last_frame_url
    let cutCount = item.source_cut_count
    // A user edit to rendered_prompt in Details always wins over a freshly rendered one.
    let renderedPrompt = item.rendered_prompt

    if (!spec || !renderedPrompt) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      const transcript = await transcribeSourceSpeech(item.video_url)
      const probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT, transcript.lineTimes)
      if (!probe) throw new Error('Could not read source video for analysis')

      spec = await extractCopyPasteSpec(probe, item.video_url, transcript)
      renderedPrompt = renderCopyPastePrompt(spec)
      aspectRatio = probe.aspectRatio
      // Picks the frame where the face actually reads well (spec.best_face_frame_time),
      // not blindly frame 0.
      firstFrameUrl = (await uploadFaceFrame(probe, spec.best_face_frame_time)) ?? firstFrameUrl
      lastFrameUrl = probe.lastFrameUrl ?? lastFrameUrl
      cutCount = probe.cutCount

      await query(
        `UPDATE discovery_items
            SET content_type = 'video_gen',
                copy_paste_spec = $2::jsonb,
                rendered_prompt = $3,
                source_duration = $4,
                source_cut_count = $5,
                source_aspect_ratio = $6,
                source_width = $7,
                source_height = $8,
                source_first_frame_url = coalesce($9, source_first_frame_url),
                source_last_frame_url = coalesce($10, source_last_frame_url)
          WHERE id = $1`,
        [
          itemId,
          JSON.stringify(spec),
          renderedPrompt,
          probe.duration,
          probe.cutCount,
          aspectRatio,
          probe.width,
          probe.height,
          firstFrameUrl,
          probe.lastFrameUrl,
        ],
      )
    }

    let generatedImageUrl = item.generated_image_url
    if (!generatedImageUrl) {
      if (!firstFrameUrl) throw new Error('No source frame captured — re-run Classify')
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      // Telegram's custom prompt now lands here, not on the Seedance call — live testing
      // showed it actually needs to steer the identity swap itself (this step), while
      // Seedance just needs to be told to use the resulting keyframe (see finishCopyPasteVideo).
      const keyframePrompt = [renderKeyframeEditPrompt(spec), opts?.customPrompt?.trim()].filter(Boolean).join(' ')
      // Written before the call, not after: if the render fails or returns
      // something wrong, the prompt that caused it is the thing worth having.
      await query(`UPDATE discovery_items SET keyframe_prompt = $2 WHERE id = $1`, [itemId, keyframePrompt])
      const keyframe = await generateCopyPasteKeyframe({
        sourceFrameUrl: firstFrameUrl,
        referenceImageUrl,
        prompt: keyframePrompt,
        aspectRatio,
        itemId,
      }, apiKey)
      generatedImageUrl = keyframe.imageUrl
      await query(
        `UPDATE discovery_items SET generated_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, generatedImageUrl],
      )
    }

    // 'auto' skips sources that cut: their last frame is from another shot, so
    // pinning it as the end makes Seedance morph between two unrelated framings.
    //
    // That rule was only as good as the cut count, and the count used to include
    // any scene-score spike — a handheld reel where the subject swings an arm
    // scored as a cut, and silently lost its end anchor. A 14s clip then had one
    // keyframe and nothing pinning where it was supposed to arrive, which is the
    // longest, least constrained render this pipeline can produce. Cuts are now
    // confirmed against the frames either side (see detectSceneCuts), so this
    // reads a measurement that means what it says.
    const wantEndFrame =
      endFrameMode === 'always' || (endFrameMode === 'auto' && cutCount === 0)
    let generatedEndImageUrl = item.generated_end_image_url
    if (wantEndFrame && !generatedEndImageUrl && lastFrameUrl) {
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const endKeyframePrompt = renderEndKeyframeEditPrompt(spec)
      await query(`UPDATE discovery_items SET end_keyframe_prompt = $2 WHERE id = $1`, [itemId, endKeyframePrompt])
      const endKeyframe = await generateCopyPasteKeyframe({
        sourceFrameUrl: lastFrameUrl,
        referenceImageUrl,
        prompt: endKeyframePrompt,
        aspectRatio,
        itemId,
        matchImageUrl: generatedImageUrl,
        slot: 'keyframe-end',
      }, apiKey)
      generatedEndImageUrl = endKeyframe.imageUrl
      await query(
        `UPDATE discovery_items SET generated_end_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, generatedEndImageUrl],
      )
    }

    await query(
      `UPDATE discovery_items
          SET replicate_status = 'awaiting_keyframe_approval', replicate_error = NULL
        WHERE id = $1`,
      [itemId],
    )
    await notifyKeyframeReady({
      userId,
      itemId,
      profile: item.profile,
      contentUrl: item.content_url,
      imageUrl: generatedImageUrl,
      endImageUrl: generatedEndImageUrl,
    }).catch(() => {})

    return { ok: true, awaitingApproval: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    await notifyReplicationFailed(userId, item.profile, msg).catch(() => {})
    throw err
  }
}

/**
 * Phase 2 of replication: the paid Seedance video-edit call, run only after a
 * human has approved the keyframe(s) generateCopyPasteKeyframes produced.
 * Everything from here down — archive, repurpose fan-out, done notification —
 * is unchanged from the old one-shot replicateCopyPasteItem.
 */
export async function finishCopyPasteVideo(
  itemId: string,
  userId: string,
  opts?: {
    repurposeCount?: number
    outputDriveFolderId?: string | null
  },
) {
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (!item.video_url) throw new Error('Item has no source video')

  const apiKey = await getUserApiKey(userId, 'wavespeed_api_key')

  // Idempotent: a requeued/retried job, or a double-tap on Approve, must not
  // pay for a second Seedance render.
  if (item.kling_video_url) {
    await query(
      `UPDATE discovery_items SET replicate_status = 'done', replicate_error = NULL WHERE id = $1`,
      [itemId],
    )
    return { ok: true, videoUrl: item.kling_video_url, model: item.video_model ?? 'cached' }
  }
  if (!item.generated_image_url) {
    throw new Error('Keyframe not ready yet — run Replicate first')
  }

  try {
    const aspectRatio: SourceAspectRatio = item.source_aspect_ratio ?? 'other'
    const lastImageUrl = item.generated_end_image_url
    const referenceImageUrls = [item.generated_image_url, ...(lastImageUrl ? [lastImageUrl] : [])]

    // Built from a short fixed instruction rather than the auto-generated scene/motion
    // description (renderCopyPastePrompt) plus an identity-lock preamble — that longer
    // form was repeatedly observed keeping the original video's face/identity instead of
    // the keyframe's, because reference_images is only documented as soft "style or
    // character guidance" for this model, not a hard constraint. Live testing (2026-08-24)
    // found this short instruction performs far more reliably — Seedance's video-edit
    // model already preserves the source's motion/timing/camera on its own, so the long
    // scene description wasn't needed and may have been diluting the identity lock.
    //
    // Still not reliable enough: confirmed live 2026-09-15 (item 589e996b) that even this
    // short instruction can lose the fight and the output keeps the ORIGINAL video's face,
    // not @Image1's — the keyframe itself was correct, only the video-edit call ignored it.
    // Strengthened per the user's explicit instruction, general (not scene-specific)
    // language only — do not reintroduce a scene/motion description here, that's the exact
    // thing 2026-08-24 found made this worse, not better. The identity clause is stated
    // twice (front and back — early tokens carry the most weight, but a second mention
    // right before the trailing text-removal instructions guards against it being the part
    // that gets dropped) and as an explicit negative against the source video's own person.
    const finalPrompt =
      'The face, body and identity of the main subject in the output MUST be @Image1 in ' +
      'every single frame from start to end — never the person who appears in the original ' +
      'source video. Use @Image1 as the primary character and visual reference. Completely ' +
      'recreate the original video using the character shown in @Image1 as the main subject, ' +
      'keeping the original motion, camera work and scene. Do not keep any part of the ' +
      'original source video\'s own person — their face, body and identity must be fully ' +
      'replaced by @Image1, not blended with it and not reverted to at any point in the clip. ' +
      'Remove text on the screen. Remove captions.'

    await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
    const result = await generateSeedanceVideo({
      videoUrl: item.video_url,
      referenceImageUrls,
      prompt: finalPrompt,
      aspectRatio,
    }, apiKey)
    // Record the variant on the row so the A/B comparison lives in the data,
    // not in whichever run someone happens to remember.
    const videoModel = lastImageUrl ? `${result.model}+end_frame` : result.model

    await query(
      `UPDATE discovery_items
          SET kling_video_url = $2, video_model = $3, sent_prompt = $4,
              replicate_status = 'done', replicate_error = NULL
        WHERE id = $1`,
      [itemId, result.videoUrl, videoModel, finalPrompt],
    )
    await archiveDiscoveryItem(itemId, { characterName: item.profile })
      .catch(err => console.error('[monitor/replicate] drive archive failed:', err))
    await enqueueRepurpose({
      userId,
      videoUrl: result.videoUrl,
      count: opts?.repurposeCount ?? 0,
      characterKey: item.profile,
      itemId,
      seriesLabel: copyPasteArchiveLabel(item.profile, item.content_id),
      outputDriveFolderId: opts?.outputDriveFolderId ?? null,
    }).catch(err => console.error('[monitor/replicate] repurpose enqueue failed:', err))
    await notifyReplicationDone({
      userId,
      profile: item.profile,
      contentUrl: item.content_url,
      contentType: item.content_type,
      videoUrl: result.videoUrl,
      // Only offer the button when nothing was spread automatically — otherwise
      // pressing it would pay for a second set of the same variants.
      itemId: (opts?.repurposeCount ?? 0) > 0 ? null : itemId,
    }).catch(() => {})

    return { ok: true, videoUrl: result.videoUrl, model: videoModel, endFrame: Boolean(lastImageUrl) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    await notifyReplicationFailed(userId, item.profile, msg).catch(() => {})
    throw err
  }
}

/**
 * Rejected keyframe: clears it (and the end keyframe) so
 * generateCopyPasteKeyframes regenerates from scratch off the same spec — a
 * fresh, differently-seeded Seedream Edit call. Paid again on purpose, only on
 * an explicit Regenerate tap.
 */
export async function regenerateCopyPasteKeyframes(
  itemId: string,
  userId: string,
  opts?: { endFrame?: EndFrameMode; customPrompt?: string | null },
) {
  await query(
    `UPDATE discovery_items
        SET generated_image_url = NULL, generated_end_image_url = NULL,
            keyframe_prompt = NULL, end_keyframe_prompt = NULL,
            replicate_status = 'classified'
      WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  return generateCopyPasteKeyframes(itemId, userId, opts)
}

/**
 * Classify-only pass for freshly scanned items. Replication always needs a
 * manually uploaded reference photo, so auto-scan can never trigger it —
 * it only gets the analysis ready for review.
 */
export async function processNewItems(userId: string, itemIds: string[]) {
  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of itemIds) {
    try {
      await classifyDiscoveryItem(id, userId)
      results.push({ id, ok: true })
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}

export async function runDueProfileScans(baseUrl: string, cronSecret: string) {
  // Claim atomically (SELECT+bump in one statement, FOR UPDATE SKIP LOCKED)
  // instead of reading then updating last_scanned_at only on success. The old
  // read-only SELECT let every overlapping tick (this self-fetches into
  // /api/monitor/scan, which itself can run minutes of Apify polling — see
  // below) grab the SAME "due" profiles and scan them again in parallel,
  // multiplying Apify cost/load with nothing to show for it. Trade-off: a
  // profile whose scan fails now waits the full 23h for retry instead of
  // getting picked up again next minute — deliberate, since instant-retry is
  // exactly what was piling ticks up.
  //
  // LIMIT dropped 10 -> 3 and the per-profile fetch now carries a hard 90s
  // timeout: each /api/monitor/scan call can run up to two sequential Apify
  // actor polls capped at 4 minutes each (see MAX_POLLS in
  // instagram-scrape.ts), so 10 of them run back-to-back could take over an
  // hour. That routinely blew past the 300s default headers timeout on the
  // node-cron self-fetch in server.mjs that calls this whole tick, which is
  // why "[cron] tick failed: HeadersTimeoutError" was showing up every
  // minute and profiles hadn't actually been scanned in weeks despite being
  // marked ACTIVE.
  const due = await rows<TrackedProfileRow>(
    `UPDATE tracked_profiles t
        SET last_scanned_at = now()
       FROM (
         SELECT id FROM tracked_profiles
          WHERE status = 'ACTIVE'
            AND platform = 'Instagram'
            AND (last_scanned_at IS NULL OR last_scanned_at < now() - interval '23 hours')
          ORDER BY last_scanned_at NULLS FIRST
          LIMIT 3
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE t.id = due.id
      RETURNING t.*`,
  )

  const summary: { profileId: string; username: string; added: number; processed: number }[] = []

  for (const profile of due) {
    try {
      const res = await fetch(`${baseUrl}/api/monitor/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({ profile_id: profile.id, user_id: profile.user_id }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await res.json()
      summary.push({
        profileId: profile.id,
        username: profile.username,
        added: data.added ?? 0,
        processed: data.processed ?? 0,
      })
    } catch (err) {
      console.error('[monitor/cron] scan failed for', profile.username, err)
    }
  }

  return summary
}
