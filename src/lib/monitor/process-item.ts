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
import {
  generateReplicaImage,
  generateReplicaImageSeedream,
  generateReplicaVideo,
  normalizeImageModel,
  normalizeVideoBackend,
} from './replicate'
import { resolveVideoBackend, type VideoBackend } from './video-backends'
import {
  enrichMotionPrompt,
  extractSceneSpec,
  normalizeSceneSpec,
  renderScenePrompt,
  type SceneSpec,
} from './scene-spec'
import { enqueueMultiShotJob } from './multi-shot'
import { getTechnique, resolveExecutable } from './techniques'
import { notifyReplicationDone, notifyReplicationFailed } from './notify'
import type {
  CharacterLora,
  DiscoveryItemRow,
  ImageModel,
  TrackedProfileRow,
  VideoTechnique,
} from './types'

/** Frames sampled per clip — denser sampling catches background gag beats. */
const PROBE_FRAME_COUNT = 8

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

    // multi_shot is executable via the queue (shared keyframe + stitch), even though
    // it has no single Wavespeed endpoint. Other null-model techniques stay parked.
    const executable = Boolean(spec.model) || analysis.video_technique === 'multi_shot'
    const status = isSkippable(analysis.content_type)
      ? 'skipped'
      : executable
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
  /** Keyframe backend — default z_image (LoRA). */
  imageModel?: ImageModel
  /** Seedream output resolution when imageModel is seedream_edit. */
  seedreamResolution?: '1k' | '2k'
  /** Video backend — default auto (by technique). */
  videoBackend?: VideoBackend
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

  const imageModel = normalizeImageModel(options?.imageModel ?? item.image_model)
  const videoBackendChoice = normalizeVideoBackend(options?.videoBackend)
  const character = characterOverride ?? await loadCharacter(profile?.character_id ?? null)
  if (!character) {
    throw new Error('No character bound to this profile — set character in Discovery')
  }
  if (imageModel === 'z_image' && !character.lora_url) {
    throw new Error('Z-Image needs a character with LoRA — bind one in Discovery, or switch to Seedream Edit')
  }
  if (imageModel === 'seedream_edit' && !item.thumbnail_url) {
    throw new Error('Seedream Edit needs a source thumbnail on the discovery item')
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

  // multi_shot has its own queue pipeline when Auto/Kling; other backends do one-shot I2V.
  const detectedMultiShot = item.video_technique === 'multi_shot' && Boolean(item.video_url)
  const resolved = detectedMultiShot
    ? { technique: 'multi_shot' as VideoTechnique, fellBack: false }
    : resolveExecutable(item.video_technique, Boolean(item.video_url))
  const technique = resolved.technique
  const fellBack = resolved.fellBack
  const videoPlan = resolveVideoBackend(videoBackendChoice, technique)
  const useMultiShot = Boolean(detectedMultiShot && videoPlan.useMultiShotQueue)
  // Prompt / image steps for multi_shot reuse the motion_transfer requirements.
  const spec = getTechnique(useMultiShot ? 'motion_transfer' : technique)

  try {
    // Probing downloads the clip and runs ffmpeg, so do it once and only when a
    // prompt we still need can't be produced without it.
    let probe: SourceProbe | null = null
    const needsProbe = isVideo && (
      !item.scene_prompt ||
      !item.scene_spec ||
      ((spec.needsMotionPrompt || videoPlan.needsMotionPrompt) && !item.motion_prompt) ||
      ((spec.needsEndImage || videoPlan.needsEndImage) && !item.end_scene_prompt)
    )
    if (needsProbe && item.video_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
    }

    let sceneSpec: SceneSpec | null = item.scene_spec
      ? normalizeSceneSpec(item.scene_spec)
      : null

    // Older specs lacked proportion_emphasis / background_people — regenerate those
    // so body size and gag beats are not permanently stuck on the thin first pass.
    const sceneSpecStale = Boolean(
      sceneSpec && (
        !sceneSpec.body.proportion_emphasis ||
        !Array.isArray((item.scene_spec as { background_people?: unknown }).background_people)
      ),
    )

    // Step 1: structured scene capture (body/wardrobe/pose/hook/people/speech).
    // Falls back to the old single-frame prose prompt if the structured path fails.
    if (!item.scene_prompt || !sceneSpec || sceneSpecStale) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      try {
        if (!probe && item.video_url) {
          probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
        }
        if (probe) {
          sceneSpec = await extractSceneSpec(probe, item.video_url)
          const scenePrompt = renderScenePrompt(sceneSpec)
          await query(
            `UPDATE discovery_items SET scene_spec = $2::jsonb, scene_prompt = $3 WHERE id = $1`,
            [itemId, JSON.stringify(sceneSpec), scenePrompt],
          )
          item.scene_prompt = scenePrompt
          item.scene_spec = sceneSpec as unknown as Record<string, unknown>
        }
      } catch (err) {
        console.warn(
          '[monitor/replicate] scene_spec failed, falling back:',
          err instanceof Error ? err.message : err,
        )
      }
    }

    // Step 1b: keyframe end-state for FLF2V, or legacy prose if structured failed.
    if (spec.needsEndImage && !item.end_scene_prompt) {
      if (!probe) throw new Error('Could not read source video for keyframe analysis')
      const { start, end } = await extractKeyframePrompts(probe)
      if (!item.scene_prompt) {
        await query(
          `UPDATE discovery_items SET scene_prompt = $2, end_scene_prompt = $3 WHERE id = $1`,
          [itemId, start, end],
        )
        item.scene_prompt = start
      } else {
        await query(
          `UPDATE discovery_items SET end_scene_prompt = $2 WHERE id = $1`,
          [itemId, end],
        )
      }
      item.end_scene_prompt = end
    } else if (!item.scene_prompt) {
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

    // Step 2: motion description — technique OR chosen video backend may need it.
    const needsMotion = spec.needsMotionPrompt || videoPlan.needsMotionPrompt
    if (needsMotion && !item.motion_prompt) {
      if (!probe && item.video_url) {
        probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
      }
      if (probe) {
        const motionPrompt = enrichMotionPrompt(await extractMotionPrompt(probe), sceneSpec)
        await query(
          `UPDATE discovery_items SET motion_prompt = $2 WHERE id = $1`,
          [itemId, motionPrompt],
        )
        item.motion_prompt = motionPrompt
      }
    }

    // Step 3: character keyframes (Z-Image+LoRA or Seedream Edit from source thumb).
    const seedreamRef = item.thumbnail_url
    const char = character
    async function makeKeyframe(scenePrompt: string): Promise<string> {
      if (imageModel === 'seedream_edit') {
        if (!seedreamRef) throw new Error('Seedream Edit needs a source thumbnail')
        return generateReplicaImageSeedream({
          scenePrompt,
          referenceImageUrls: [seedreamRef],
          triggerWord: char.trigger_word,
          basePromptStyle: char.base_prompt_style,
          resolution: options?.seedreamResolution ?? '1k',
        })
      }
      return generateReplicaImage({
        scenePrompt,
        loraUrl: char.lora_url,
        loraScale: char.lora_scale,
        triggerWord: char.trigger_word,
        basePromptStyle: char.base_prompt_style,
      })
    }

    if (!item.generated_image_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const imageUrl = await makeKeyframe(item.scene_prompt!)
      await query(
        `UPDATE discovery_items
            SET generated_image_url = $2, image_model = $3, replicate_status = 'image_done'
          WHERE id = $1`,
        [itemId, imageUrl, imageModel],
      )
      item.generated_image_url = imageUrl
      item.image_model = imageModel
    }

    const needsEndFrame = spec.needsEndImage || videoPlan.needsEndImage
    if (needsEndFrame && !item.generated_end_image_url) {
      if (!item.end_scene_prompt) {
        if (!probe && item.video_url) {
          probe = await probeSourceVideo(item.video_url, PROBE_FRAME_COUNT)
        }
        if (probe) {
          const { end } = await extractKeyframePrompts(probe)
          await query(
            `UPDATE discovery_items SET end_scene_prompt = $2 WHERE id = $1`,
            [itemId, end],
          )
          item.end_scene_prompt = end
        }
      }
      if (!item.end_scene_prompt) {
        throw new Error('End-frame prompt missing — cannot generate last keyframe')
      }
      await query(`UPDATE discovery_items SET replicate_status = 'image_generating' WHERE id = $1`, [itemId])
      const endImageUrl = await makeKeyframe(item.end_scene_prompt)
      await query(
        `UPDATE discovery_items
            SET generated_end_image_url = $2, image_model = $3, replicate_status = 'image_done'
          WHERE id = $1`,
        [itemId, endImageUrl, imageModel],
      )
      item.generated_end_image_url = endImageUrl
      item.image_model = imageModel
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

    // Step 4: video — multi_shot goes through the queue (minutes of work);
    // everything else stays inline on whichever model the technique resolved to.
    if (isVideo && !item.kling_video_url) {
      if (useMultiShot) {
        if (!item.video_url || !item.generated_image_url) {
          throw new Error('Multi-shot requires a source video and a generated keyframe')
        }
        const segmentCount = Math.max(2, (item.source_cut_count ?? 1) + 1)
        const jobId = await enqueueMultiShotJob({
          userId,
          discoveryItemId: itemId,
          imageUrl: item.generated_image_url,
          sourceVideoUrl: item.video_url,
          segmentCount,
        })
        await query(
          `UPDATE discovery_items
              SET replicate_status = 'video_generating',
                  video_technique = 'multi_shot',
                  video_model = 'multi_shot+kling-motion-control',
                  replicate_error = NULL
            WHERE id = $1`,
          [itemId],
        )
        // Kick the worker immediately; cron is the backup if this fetch fails.
        const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'
        const secret = process.env.CRON_SECRET
        if (secret) {
          await query(
            `UPDATE generation_queue
                SET status = 'processing', started_at = now(), attempts = attempts + 1
              WHERE id = $1 AND status = 'pending'`,
            [jobId],
          ).catch(() => {})
          fetch(`${base}/api/queue/process/${jobId}`, {
            method: 'POST',
            headers: { 'x-cron-secret': secret },
          }).catch(err => console.error('[monitor/multi-shot] fire process:', err))
        }
        return {
          ok: true,
          queued: true,
          jobId,
          imageUrl: item.generated_image_url,
          technique: 'multi_shot' as VideoTechnique,
          fellBack: false,
        }
      }

      if (videoPlan.needsLora && !character.lora_url) {
        throw new Error('LTX + LoRA needs a character with LoRA URL')
      }
      await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
      // When multi_shot was detected but user picked Seedance/LTX, run one-shot I2V instead.
      const videoTechnique: VideoTechnique = useMultiShot
        ? 'multi_shot'
        : (technique === 'multi_shot' ? 'image_to_video' : technique)
      const result = await generateReplicaVideo({
        technique: videoTechnique,
        videoBackend: videoBackendChoice === 'auto' ? videoPlan.backend : videoBackendChoice,
        imageUrl: item.generated_image_url!,
        endImageUrl: item.generated_end_image_url,
        sourceVideoUrl: item.video_url,
        motionPrompt: item.motion_prompt,
        duration: item.source_duration ?? probe?.duration ?? null,
        loraUrl: character.lora_url,
        loraScale: character.lora_scale,
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
