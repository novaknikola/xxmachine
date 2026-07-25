/**
 * Binds a character to a tracked profile, approves one discovery item and replicates it.
 * Stops at the keyframe image by default so the scene and likeness can be judged before
 * paying for video generation; pass --video to run the whole chain.
 *
 * Usage: npx tsx scripts/test-replicate-image.ts <character> <username> [shortcode] [--video]
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const withVideo = process.argv.includes('--video')

const characterName = args[0] ?? 'Tiana'
const username = args[1] ?? 'gracie.bestie_'
const shortcode = args[2]

async function main() {
  const { one, query } = await import('../src/lib/db')
  const { replicateDiscoveryItem } = await import('../src/lib/monitor/process-item')
  const { getTechnique } = await import('../src/lib/monitor/techniques')

  const character = await one<{ id: string; name: string; lora_url: string | null; lora_scale: number }>(
    `SELECT id, name, lora_url, COALESCE(lora_scale, 0.8)::float AS lora_scale
       FROM characters WHERE lower(name) = lower($1)`,
    [characterName],
  )
  if (!character) throw new Error(`No character named ${characterName}`)
  if (!character.lora_url) throw new Error(`${character.name} has no LoRA URL`)
  console.log(`Character: ${character.name} (LoRA scale ${character.lora_scale})`)

  const profile = await one<{ id: string; user_id: string; character_id: string | null }>(
    `SELECT id, user_id, character_id FROM tracked_profiles
      WHERE lower(username) = lower($1) AND platform = 'Instagram' LIMIT 1`,
    [username],
  )
  if (!profile) throw new Error(`No tracked profile for @${username}`)

  if (profile.character_id !== character.id) {
    await query(`UPDATE tracked_profiles SET character_id = $2 WHERE id = $1`, [profile.id, character.id])
    console.log(`Bound ${character.name} to @${username}`)
  }

  // Prefer an item the classifier already routed to an executable technique.
  const item = await one<{
    id: string
    content_url: string
    video_technique: string | null
    replicate_status: string
    admin_status: string
  }>(
    shortcode
      ? `SELECT id, content_url, video_technique, replicate_status, admin_status
           FROM discovery_items
          WHERE user_id = $1 AND content_url LIKE '%' || $2 || '%' LIMIT 1`
      : `SELECT id, content_url, video_technique, replicate_status, admin_status
           FROM discovery_items
          WHERE user_id = $1 AND lower(profile) = lower($2)
            AND replicate_status NOT IN ('needs_review', 'skipped')
          ORDER BY posted_at DESC NULLS LAST LIMIT 1`,
    shortcode ? [profile.user_id, shortcode] : [profile.user_id, username],
  )
  if (!item) throw new Error('No replicable discovery item found — run the detection test first')

  console.log(`Item     : ${item.content_url}`)
  console.log(`Technique: ${item.video_technique} -> ${getTechnique(item.video_technique as never).model}`)

  if (item.admin_status !== 'APPROVED') {
    await query(`UPDATE discovery_items SET admin_status = 'APPROVED' WHERE id = $1`, [item.id])
    console.log('Approved item for replication')
  }

  console.log(withVideo ? '\nReplicating the full chain…\n' : '\nReplicating up to the keyframe image…\n')
  const result = await replicateDiscoveryItem(
    item.id,
    profile.user_id,
    null,
    { stopAfterImage: !withVideo },
  )

  const row = await one<{
    scene_prompt: string | null
    motion_prompt: string | null
    generated_image_url: string | null
    generated_end_image_url: string | null
    kling_video_url: string | null
    video_model: string | null
    replicate_status: string
  }>(
    `SELECT scene_prompt, motion_prompt, generated_image_url, generated_end_image_url,
            kling_video_url, video_model, replicate_status
       FROM discovery_items WHERE id = $1`,
    [item.id],
  )

  console.log('status      :', row?.replicate_status)
  console.log('\nscene prompt:\n', row?.scene_prompt ?? '(none)')
  if (row?.motion_prompt) console.log('\nmotion prompt:\n', row.motion_prompt)
  console.log('\nimage       :', row?.generated_image_url ?? '(none)')
  if (row?.generated_end_image_url) console.log('end image   :', row.generated_end_image_url)
  if (row?.kling_video_url) {
    console.log('video       :', row.kling_video_url)
    console.log('video model :', row.video_model)
  }
  console.log('\nresult      :', JSON.stringify(result))

  process.exit(0)
}

main().catch(err => {
  console.error('FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
