import { one, query, rows } from '@/lib/db'
import { classifyContentImage } from './classify'
import { extractScenePrompt, getFrameBase64 } from './analyze'
import { generateReplicaImage, generateReplicaVideo } from './replicate'
import type { CharacterLora, DiscoveryItemRow, TrackedProfileRow } from './types'

export async function loadCharacter(characterId: string | null): Promise<CharacterLora | null> {
  if (!characterId) return null
  return one<CharacterLora>(
    `SELECT id, name, lora_url, COALESCE(lora_scale, 0.8)::float AS lora_scale,
            trigger_word, base_prompt_style
       FROM characters WHERE id = $1`,
    [characterId],
  )
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
    const frame = await getFrameBase64({
      videoUrl: item.video_url,
      thumbnailUrl: item.thumbnail_url,
      tag: itemId.slice(0, 8),
    })
    const result = await classifyContentImage(frame)

    await query(
      `UPDATE discovery_items
          SET content_type = $2, category = $2, replicate_status = 'classified', replicate_error = NULL
        WHERE id = $1`,
      [itemId, result.content_type],
    )

    if (result.content_type === 'real_photo' || result.content_type === 'other') {
      await query(
        `UPDATE discovery_items SET replicate_status = 'skipped' WHERE id = $1`,
        [itemId],
      )
    }

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    throw err
  }
}

export async function replicateDiscoveryItem(
  itemId: string,
  userId: string,
  characterOverride?: CharacterLora | null,
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

  if (contentType === 'real_photo' || contentType === 'other') {
    await query(
      `UPDATE discovery_items SET replicate_status = 'skipped' WHERE id = $1`,
      [itemId],
    )
    return { skipped: true, reason: contentType }
  }

  try {
    // Step 1: Scene prompt
    if (!item.scene_prompt) {
      await query(`UPDATE discovery_items SET replicate_status = 'analyzing' WHERE id = $1`, [itemId])
      const scenePrompt = await extractScenePrompt({
        videoUrl: item.video_url,
        thumbnailUrl: item.thumbnail_url,
        tag: itemId.slice(0, 8),
      })
      await query(
        `UPDATE discovery_items SET scene_prompt = $2 WHERE id = $1`,
        [itemId, scenePrompt],
      )
      item.scene_prompt = scenePrompt
    }

    // Step 2: Image
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

    // Step 3: Video (for video_gen)
    if (contentType === 'video_gen' && item.video_url && !item.kling_video_url) {
      await query(`UPDATE discovery_items SET replicate_status = 'video_generating' WHERE id = $1`, [itemId])
      const videoUrl = await generateReplicaVideo(item.generated_image_url!, item.video_url)
      await query(
        `UPDATE discovery_items SET kling_video_url = $2, replicate_status = 'done', replicate_error = NULL WHERE id = $1`,
        [itemId, videoUrl],
      )
      return { ok: true, imageUrl: item.generated_image_url, videoUrl }
    }

    await query(
      `UPDATE discovery_items SET replicate_status = 'done', replicate_error = NULL WHERE id = $1`,
      [itemId],
    )
    return { ok: true, imageUrl: item.generated_image_url, videoUrl: item.kling_video_url }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items SET replicate_status = 'failed', replicate_error = $2 WHERE id = $1`,
      [itemId, msg],
    )
    throw err
  }
}

export async function processNewItems(userId: string, itemIds: string[]) {
  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of itemIds) {
    try {
      await classifyDiscoveryItem(id, userId)
      const item = await one<{ content_type: string | null; admin_status: string }>(
        `SELECT content_type, admin_status FROM discovery_items WHERE id = $1`,
        [id],
      )
      if (item?.admin_status === 'APPROVED' && item.content_type && !['real_photo', 'other'].includes(item.content_type)) {
        await replicateDiscoveryItem(id, userId)
      }
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
