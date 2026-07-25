import { one, query, rows } from '@/lib/db'
import { analyzeVideoContent, classifyContentImage } from './classify'
import {
  extractKeyframePrompts,
  extractMotionPrompt,
  getFrameBase64,
  probeSourceVideo,
  scenePromptFromFrame,
  type SourceProbe,
} from './analyze'
import { generateReplicaImage, generateReplicaVideo } from './replicate'
import { getTechnique, resolveExecutable } from './techniques'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import type { CharacterLora, DiscoveryItemRow, TrackedProfileRow, VideoTechnique } from './types'

/** Frames sampled per clip for technique detection. */
const PROBE_FRAME_COUNT = 5

export async function loadCharacter(characterId: string | null): Promise<CharacterLora | null> {
  if (!characterId) return null
  return one<CharacterLora>(
    `SELECT id, name, lora_url, COALESCE(lora_scale, 0.8)::float AS lora_scale,
            trigger_word, base_prompt_style
       FROM characters WHERE id = $1`,
    [characterId],
  )
}

/**
 * Only content with nothing to reproduce is skipped. Whether the source was generated
 * or filmed does not matter — we are recreating the shot with our own character either
 * way, and authentic footage is often the better reference.
 */
function isSkippable(contentType: string | null): boolean {
  return contentType === 'other'
}

/** Still-only content yields just a keyframe; anything else with a clip gets a video. */
function shouldGenerateVideo(contentType: string | null, videoUrl: string | null): boolean {
  if (!videoUrl) return false
  return contentType !== 'carousel' && contentType !== 'image_gen'
}

export async function classifyDiscoveryItem(itemId: string, userId: string) {
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')

  await query(
    `UPDATE discovery_items SET replicate_status = 'analyzing', replicate_error = NULL WHERE id = $1`,
    [itemId],
  )

  try {
    // With a source clip we can measure duration and cuts, which lets us decide the
    // technique. Without one there is nothing to detect beyond the content type.
    const probe = item.video_url
      ? await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
      : null

    if (!probe) {
      const frame = await getFrameBase64({
        videoUrl: item.video_url,
        thumbnailUrl: item.thumbnail_url,
        tag: itemId.slice(0, 8),
      })
      const result = await classifyContentImage(frame)

      await query(
        `UPDATE discovery_items
            SET content_type = $2, category = $2,
                replicate_status = $3, replicate_error = NULL
          WHERE id = $1`,
        [
          itemId,
          result.content_type,
          isSkippable(result.content_type) ? 'skipped' : 'classified',
        ],
      )
      return { ...result, video_technique: null as VideoTechnique | null }
    }

    const analysis = await analyzeVideoContent(probe)
    const spec = getTechnique(analysis.video_technique)

    // Park what we can identify but cannot yet reproduce, rather than routing it
    // to a model that would return something unrelated.
    const status = isSkippable(analysis.content_type)
      ? 'skipped'
      : spec.model
        ? 'classified'
        : 'needs_review'

    await query(
      `UPDATE discovery_items
          SET content_type = $2, category = $2,
              video_technique = $3, technique_confidence = $4, technique_reasoning = $5,
              source_duration = $6, source_cut_count = $7,
              replicate_status = $8,
              replicate_error = $9
        WHERE id = $1`,
      [
        itemId,
        analysis.content_type,
        analysis.video_technique,
        analysis.technique_confidence,
        analysis.reasoning,
        probe.duration,
        probe.cutCount,
        status,
        status === 'needs_review' ? spec.reviewReason ?? null : null,
      ],
    )

    return {
      content_type: analysis.content_type,
      confidence: analysis.technique_confidence,
      reasoning: analysis.reasoning,
      suggested_pipeline: spec.label,
      video_technique: analysis.video_technique,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    throw err
  }
}

export interface ReplicateOptions {
  /** Stop once the keyframes exist, so they can be reviewed before paying for video. */
  stopAfterImage?: boolean
}

export async function replicateDiscoveryItem(
  itemId: string,
  userId: string,
  characterOverride?: CharacterLora | null,
  options?: ReplicateOptions,
) {
  const item = await one<DiscoveryItemRow>(
    `SELECT * FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  )
  if (!item) throw new Error('Item not found')
  if (item.admin_status !== 'APPROVED') throw new Error('Item must be approved before replication')

  const profile = await one<TrackedProfileRow>(
    `SELECT * FROM tracked_profiles
      WHERE user_id = $1 AND platform = $2 AND username = $3
      LIMIT 1`,
    [userId, item.platform, item.profile],
  )

  const character = characterOverride ?? await loadCharacter(profile?.character_id ?? null)
  if (!character?.lora_url) {
    throw new Error('No character with LoRA bound to this profile — set character in Discovery')
  }

  const contentType = item.content_type ?? 'video_gen'

  if (isSkippable(contentType)) {
    await query(
      `UPDATE discovery_items SET replicate_status = 'skipped' WHERE id = $1`,
      [itemId],
    )
    return { skipped: true, reason: contentType }
  }

  const isVideo = shouldGenerateVideo(contentType, item.video_url)

  // Techniques we cannot build are parked as needs_review during classification, which
  // keeps autopilot away from them. Reaching this function means someone asked for it
  // explicitly, so fall back to the closest runnable approach and record what was used.
  const { technique, fellBack } = resolveExecutable(item.video_technique, Boolean(item.video_url))
  const spec = getTechnique(technique)

  try {
    // Probing downloads the clip and runs ffmpeg, so do it once and only when a
    // prompt we still need can't be produced without it.
    let probe: SourceProbe | null = null
    const needsProbe = isVideo && (
      !item.scene_prompt ||
      (spec.needsMotionPrompt && !item.motion_prompt) ||
      (spec.needsEndImage && !item.end_scene_prompt)
    )
    if (needsProbe && item.video_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
    }

    // Step 1: keyframe descriptions — two of them when interpolating between states.
    if (spec.needsEndImage && (!item.scene_prompt || !item.end_scene_prompt)) {
      if (!probe) throw new Error('Could not read source video for keyframe analysis')
      const { start, end } = await extractKeyframePrompts(probe)
      await query(
        `UPDATE discovery_items SET scene_prompt = $2, end_scene_prompt = $3 WHERE id = $1`,
        [itemId, start, end],
      )
      item.scene_prompt = start
      item.end_scene_prompt = end
    } else if (!item.scene_prompt) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      const scenePrompt = probe
        ? await scenePromptFromFrame(probe.frames[0])
        : await scenePromptFromFrame(await getFrameBase64({
            videoUrl: item.video_url,
            thumbnailUrl: item.thumbnail_url,
            tag: itemId.slice(0, 8),
          }))
      await query(
        `UPDATE discovery_items SET scene_prompt = $2 WHERE id = $1`,
        [itemId, scenePrompt],
      )
      item.scene_prompt = scenePrompt
    }

    // Step 2: motion description, for the models that are driven by it.
    if (spec.needsMotionPrompt && !item.motion_prompt && probe) {
      const motionPrompt = await extractMotionPrompt(probe)
      await query(
        `UPDATE discovery_items SET motion_prompt = $2 WHERE id = $1`,
        [itemId, motionPrompt],
      )
      item.motion_prompt = motionPrompt
    }

    // Step 3: character keyframes.
    if (!item.generated_image_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const imageUrl = await generateReplicaImage({
        scenePrompt: item.scene_prompt!,
        loraUrl: character.lora_url,
        loraScale: character.lora_scale,
        triggerWord: character.trigger_word,
        basePromptStyle: character.base_prompt_style,
      })
      await query(
        `UPDATE discovery_items SET generated_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, imageUrl],
      )
      item.generated_image_url = imageUrl
    }

    if (spec.needsEndImage && !item.generated_end_image_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const endImageUrl = await generateReplicaImage({
        scenePrompt: item.end_scene_prompt!,
        loraUrl: character.lora_url,
        loraScale: character.lora_scale,
        triggerWord: character.trigger_word,
        basePromptStyle: character.base_prompt_style,
      })
      await query(
        `UPDATE discovery_items SET generated_end_image_url = $2, replicate_status = 'image_done' WHERE id = $1`,
        [itemId, endImageUrl],
      )
      item.generated_end_image_url = endImageUrl
    }

    if (options?.stopAfterImage) {
      await query(
        `UPDATE discovery_items SET replicate_status = 'image_done', replicate_error = NULL WHERE id = $1`,
        [itemId],
      )
      return {
        ok: true,
        stoppedAfterImage: true,
        imageUrl: item.generated_image_url,
        endImageUrl: item.generated_end_image_url,
        technique,
        fellBack,
      }
    }

    // Step 4: video via whichever model the technique resolved to.
    if (isVideo && !item.kling_video_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
      const result = await generateReplicaVideo({
        technique,
        imageUrl: item.generated_image_url!,
        endImageUrl: item.generated_end_image_url,
        sourceVideoUrl: item.video_url,
        motionPrompt: item.motion_prompt,
        duration: item.source_duration ?? probe?.duration ?? null,
      })
      await query(
        `UPDATE discovery_items
            SET kling_video_url = $2, video_model = $3, video_technique = $4,
                replicate_status = 'done', replicate_error = NULL
          WHERE id = $1`,
        [itemId, result.videoUrl, result.model, result.technique],
      )
      await notifyReplicationDone({
        userId,
        profile: item.profile,
        contentUrl: item.content_url,
        contentType,
        imageUrl: item.generated_image_url,
        videoUrl: result.videoUrl,
      }).catch(() => {})
      return {
        ok: true,
        imageUrl: item.generated_image_url,
        videoUrl: result.videoUrl,
        technique: result.technique,
        model: result.model,
        fellBack,
      }
    }

    await query(
      `UPDATE discovery_items SET replicate_status = 'done', replicate_error = NULL WHERE id = $1`,
      [itemId],
    )
    await notifyReplicationDone({
      userId,
      profile: item.profile,
      contentUrl: item.content_url,
      contentType,
      imageUrl: item.generated_image_url,
      videoUrl: item.kling_video_url,
    }).catch(() => {})
    return { ok: true, imageUrl: item.generated_image_url, videoUrl: item.kling_video_url }
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

export async function processNewItems(userId: string, itemIds: string[]) {
  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of itemIds) {
    try {
      await classifyDiscoveryItem(id, userId)
      const item = await one<{
        content_type: string | null
        admin_status: string
        replicate_status: string
      }>(
        `SELECT content_type, admin_status, replicate_status FROM discovery_items WHERE id = $1`,
        [id],
      )
      const replicable =
        item?.admin_status === 'APPROVED' &&
        item.content_type &&
        !isSkippable(item.content_type) &&
        item.replicate_status !== 'needs_review'

      if (replicable) await replicateDiscoveryItem(id, userId)
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
