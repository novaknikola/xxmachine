import { one, query, rows } from '@/lib/db'
import {
  extractCopyPasteSpec,
  normalizeCopyPasteSpec,
  renderCopyPastePrompt,
  renderKeyframeEditPrompt,
  type CopyPasteSpec,
} from './copy-paste-spec'
import { probeSourceVideo, type SourceAspectRatio } from './analyze'
import { generateCopyPasteKeyframe, generateSeedanceVideo } from './replicate'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import { archiveDiscoveryItem } from '@/lib/drive-archive/from-discovery-item'
import type { DiscoveryItemRow, TrackedProfileRow } from './types'

/** Frames sampled per clip — denser sampling catches background gag beats. */
const PROBE_FRAME_COUNT = 8

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
    const probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
    if (!probe) throw new Error('Could not read source video')

    const spec = await extractCopyPasteSpec(probe, item.video_url)
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
export async function replicateCopyPasteItem(itemId: string, userId: string) {
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (item.admin_status !== 'APPROVED') throw new Error('Item must be approved before replication')
  if (!item.reference_image_url) throw new Error('No reference photo uploaded for this batch')
  if (!item.video_url) throw new Error('Item has no source video')

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
    // A user edit to rendered_prompt in Details always wins over a freshly rendered one.
    let renderedPrompt = item.rendered_prompt

    if (!spec || !renderedPrompt) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      const probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
      if (!probe) throw new Error('Could not read source video for analysis')

      spec = await extractCopyPasteSpec(probe, item.video_url)
      renderedPrompt = renderCopyPastePrompt(spec)
      durationSec = probe.duration
      aspectRatio = probe.aspectRatio
      firstFrameUrl = probe.firstFrameUrl ?? firstFrameUrl

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
                source_first_frame_url = coalesce($9, source_first_frame_url)
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
        ],
      )
    }

    let generatedImageUrl = item.generated_image_url
    if (!generatedImageUrl) {
      if (!firstFrameUrl) throw new Error('No source frame captured — re-run Classify')
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const keyframe = await generateCopyPasteKeyframe({
        sourceFrameUrl: firstFrameUrl,
        referenceImageUrl: item.reference_image_url,
        prompt: renderKeyframeEditPrompt(spec),
        aspectRatio,
        itemId,
      })
      generatedImageUrl = keyframe.imageUrl
      await query(
        `UPDATE discovery_items SET generated_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, generatedImageUrl],
      )
    }

    await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
    const result = await generateSeedanceVideo({
      imageUrl: generatedImageUrl,
      prompt: renderedPrompt,
      durationSec,
      aspectRatio,
    })

    await query(
      `UPDATE discovery_items
          SET kling_video_url = $2, video_model = $3,
              replicate_status = 'done', replicate_error = NULL
        WHERE id = $1`,
      [itemId, result.videoUrl, result.model],
    )
    await archiveDiscoveryItem(itemId, { characterName: item.profile })
      .catch(err => console.error('[monitor/replicate] drive archive failed:', err))
    await notifyReplicationDone({
      userId,
      profile: item.profile,
      contentUrl: item.content_url,
      contentType: item.content_type,
      videoUrl: result.videoUrl,
    }).catch(() => {})

    return { ok: true, videoUrl: result.videoUrl, model: result.model }
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
