/**
 * Re-run scene-spec + image + video on the first (oldest done) Gracie reel.
 *
 *   npx tsx scripts/regen-first-video.ts
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

async function main() {
  const { one, query } = await import('../src/lib/db')
  const { replicateDiscoveryItem } = await import('../src/lib/monitor/process-item')

  const item = await one<{
    id: string
    user_id: string
    profile: string
    content_url: string
    video_technique: string | null
    replicate_status: string
    generated_image_url: string | null
    kling_video_url: string | null
  }>(
    `SELECT id, user_id, profile, content_url, video_technique, replicate_status,
            generated_image_url, kling_video_url
       FROM discovery_items
      WHERE profile = $1
        AND admin_status = 'APPROVED'
        AND video_url IS NOT NULL
      ORDER BY discovered_at ASC
      LIMIT 1`,
    ['gracie.bestie_'],
  )

  if (!item) throw new Error('No approved Gracie item found')
  console.log('item', item.id, item.video_technique, item.content_url)

  // Wipe prior generation so the new scene-spec path rebuilds image + video.
  await query(
    `UPDATE discovery_items
        SET scene_prompt = NULL,
            scene_spec = NULL,
            end_scene_prompt = NULL,
            motion_prompt = NULL,
            generated_image_url = NULL,
            generated_end_image_url = NULL,
            kling_video_url = NULL,
            video_model = NULL,
            replicate_status = 'classified',
            replicate_error = NULL
      WHERE id = $1`,
    [item.id],
  )

  console.log('WAVESPEED set?', Boolean(process.env.WAVESPEED_API_KEY))
  console.log('replicating…')

  const result = await replicateDiscoveryItem(item.id, item.user_id)
  console.log('result', JSON.stringify(result, null, 2))

  const after = await one<{
    replicate_status: string
    video_technique: string | null
    video_model: string | null
    generated_image_url: string | null
    kling_video_url: string | null
    scene_prompt: string | null
    scene_spec: {
      body?: { proportion_emphasis?: string; bust?: string; glutes?: string }
      must_include_events?: string[]
      background_people?: Array<{ who?: string; action?: string }>
    } | null
  }>(
    `SELECT replicate_status, video_technique, video_model,
            generated_image_url, kling_video_url, scene_prompt, scene_spec
       FROM discovery_items WHERE id = $1`,
    [item.id],
  )

  console.log('\n=== STATUS ===')
  console.log(after?.replicate_status, after?.video_technique, after?.video_model)
  console.log('\n=== BODY ===')
  console.log(after?.scene_spec?.body)
  console.log('\n=== MUST INCLUDE ===')
  console.log(after?.scene_spec?.must_include_events)
  console.log('\n=== BACKGROUND ===')
  console.log(JSON.stringify(after?.scene_spec?.background_people, null, 2))
  console.log('\n=== SCENE PROMPT (first 600) ===')
  console.log((after?.scene_prompt ?? '').slice(0, 600))
  console.log('\n=== IMAGE ===')
  console.log(after?.generated_image_url)
  console.log('\n=== VIDEO ===')
  console.log(after?.kling_video_url)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
