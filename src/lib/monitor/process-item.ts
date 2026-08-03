import { one, query, rows } from '@/lib/db'
import {
  extractCopyPasteSpec,
  transcribeSourceSpeech,
  normalizeCopyPasteSpec,
  renderCopyPastePrompt,
  renderEndKeyframeEditPrompt,
  renderKeyframeEditPrompt,
  type CopyPasteSpec,
} from './copy-paste-spec'
import { probeSourceVideo, type SourceAspectRatio } from './analyze'
import { generateCopyPasteKeyframe, generateSeedanceVideo } from './replicate'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import { archiveDiscoveryItem } from '@/lib/drive-archive/from-discovery-item'
import type { DiscoveryItemRow, EndFrameMode, TrackedProfileRow } from './types'

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
        videoName: `copypaste_${opts.itemId.slice(0, 8)}.mp4`,
        count: opts.count,
        baseSeed: Math.floor(Math.random() * 0xffffff),
        // Everything on: the point is maximum spread between variants.
        effects: {
          brightness: true, contrast: true, saturation: true,
          hue: true, speed: true, flipH: true, crop: true, fade: false,
        },
        archiveToDrive: true,
        characterKey: opts.characterKey,
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
  fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/queue/process/${job.id}`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  }).catch(err => console.error('[monitor/replicate] fire repurpose worker:', err))
}

/**
 * Analysis-only step: probes the source clip and produces the CopyPasteSpec +
 * rendered prompt so they can be reviewed/edited before paying for a Seedance call.
 * Requires a source video — Copy-Paste has no still-image path.
 */
export async function classifyDiscoveryItem(itemId: string, userId: string) {
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
    // Transcript first: its line times decide where extra frames go, so that
    // speech attribution has a frame at the moment each line was spoken.
    const transcript = await transcribeSourceSpeech(item.video_url)
    const probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT, transcript.lineTimes)
    if (!probe) throw new Error('Could not read source video')

    const spec = await extractCopyPasteSpec(probe, item.video_url, transcript)
    const renderedPrompt = renderCopyPastePrompt(spec)

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
              source_last_frame_url = coalesce($10, source_last_frame_url),
              replicate_status = 'classified',
              replicate_error = NULL
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
        probe.firstFrameUrl,
        // Without this the end-frame variant silently never fires: Replicate
        // skips its probe when a spec already exists, so the only chance to
        // capture the last frame is here.
        probe.lastFrameUrl,
      ],
    )

    return { content_type: 'video_gen' as const, spec, renderedPrompt }
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
 * Replication: reference photo + source first-frame composited into a
 * Seedream v5 Pro Edit keyframe, then that keyframe + rendered prompt into
 * Seedance 2.0 i2v. Runs analysis first if it hasn't happened yet.
 */
export async function replicateCopyPasteItem(
  itemId: string,
  userId: string,
  opts?: { endFrame?: EndFrameMode; repurposeCount?: number },
) {
  const endFrameMode: EndFrameMode = opts?.endFrame ?? 'auto'
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (item.admin_status !== 'APPROVED') throw new Error('Item must be approved before replication')
  if (!item.video_url) throw new Error('Item has no source video')

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
    return { ok: true, videoUrl: item.kling_video_url, model: item.video_model ?? 'cached' }
  }

  try {
    let spec: CopyPasteSpec | null = item.copy_paste_spec
      ? normalizeCopyPasteSpec(item.copy_paste_spec)
      : null
    let durationSec = item.source_duration
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
      durationSec = probe.duration
      aspectRatio = probe.aspectRatio
      firstFrameUrl = probe.firstFrameUrl ?? firstFrameUrl
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
          durationSec,
          probe.cutCount,
          aspectRatio,
          probe.width,
          probe.height,
          probe.firstFrameUrl,
          probe.lastFrameUrl,
        ],
      )
    }

    let generatedImageUrl = item.generated_image_url
    if (!generatedImageUrl) {
      if (!firstFrameUrl) throw new Error('No source frame captured — re-run Classify')
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const keyframePrompt = renderKeyframeEditPrompt(spec)
      // Written before the call, not after: if the render fails or returns
      // something wrong, the prompt that caused it is the thing worth having.
      await query(`UPDATE discovery_items SET keyframe_prompt = $2 WHERE id = $1`, [itemId, keyframePrompt])
      const keyframe = await generateCopyPasteKeyframe({
        sourceFrameUrl: firstFrameUrl,
        referenceImageUrl,
        prompt: keyframePrompt,
        aspectRatio,
        itemId,
      })
      generatedImageUrl = keyframe.imageUrl
      await query(
        `UPDATE discovery_items SET generated_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, generatedImageUrl],
      )
    }

    // 'auto' skips sources that cut: their last frame is from another shot, so
    // pinning it as the end makes Seedance morph between two unrelated framings.
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
      })
      generatedEndImageUrl = endKeyframe.imageUrl
      await query(
        `UPDATE discovery_items SET generated_end_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, generatedEndImageUrl],
      )
    }
    const lastImageUrl = wantEndFrame ? generatedEndImageUrl : null

    await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
    const result = await generateSeedanceVideo({
      imageUrl: generatedImageUrl,
      lastImageUrl,
      prompt: renderedPrompt,
      durationSec,
      aspectRatio,
    })
    // Record the variant on the row so the A/B comparison lives in the data,
    // not in whichever run someone happens to remember.
    const videoModel = lastImageUrl ? `${result.model}+end_frame` : result.model

    await query(
      `UPDATE discovery_items
          SET kling_video_url = $2, video_model = $3,
              replicate_status = 'done', replicate_error = NULL
        WHERE id = $1`,
      [itemId, result.videoUrl, videoModel],
    )
    await archiveDiscoveryItem(itemId, { characterName: item.profile })
      .catch(err => console.error('[monitor/replicate] drive archive failed:', err))
    await enqueueRepurpose({
      userId,
      videoUrl: result.videoUrl,
      count: opts?.repurposeCount ?? 0,
      characterKey: item.profile,
      itemId,
    }).catch(err => console.error('[monitor/replicate] repurpose enqueue failed:', err))
    await notifyReplicationDone({
      userId,
      profile: item.profile,
      contentUrl: item.content_url,
      contentType: item.content_type,
      videoUrl: result.videoUrl,
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
  const due = await rows<TrackedProfileRow>(
    `SELECT * FROM tracked_profiles
      WHERE status = 'ACTIVE'
        AND platform = 'Instagram'
        AND (last_scanned_at IS NULL OR last_scanned_at < now() - interval '23 hours')
      ORDER BY last_scanned_at NULLS FIRST
      LIMIT 10`,
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
