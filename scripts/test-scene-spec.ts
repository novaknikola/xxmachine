/**
 * Extract a structured scene spec from a discovery item (or a direct video URL)
 * and print the rendered image prompt for inspection.
 *
 *   npx tsx scripts/test-scene-spec.ts
 *   npx tsx scripts/test-scene-spec.ts --url <videoUrl>
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { one } from '../src/lib/db'
import { probeSourceVideo, scenePromptFromFrame } from '../src/lib/monitor/analyze'
import {
  extractSceneSpec,
  renderScenePrompt,
} from '../src/lib/monitor/scene-spec'

async function main() {
  const urlFlag = process.argv.indexOf('--url')
  let videoUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : ''
  let oldPrompt: string | null = null

  if (!videoUrl) {
    const item = await one<{
      id: string
      profile: string
      video_url: string | null
      scene_prompt: string | null
    }>(
      `SELECT id, profile, video_url, scene_prompt FROM discovery_items
        WHERE video_url IS NOT NULL AND profile = $1
        ORDER BY CASE WHEN replicate_status = 'done' THEN 0 ELSE 1 END, discovered_at DESC
        LIMIT 1`,
      ['gracie.bestie_'],
    )
    if (!item?.video_url) throw new Error('No gracie.bestie_ item with video_url')
    videoUrl = item.video_url
    oldPrompt = item.scene_prompt
    console.log('item', item.id, '@' + item.profile)
  }

  console.log('probing', videoUrl.slice(0, 90))
  const probe = await probeSourceVideo(videoUrl, 5)
  if (!probe) throw new Error('probe failed')
  console.log('frames', probe.frames.length, 'dur', probe.duration, 'cuts', probe.cutCount, 'audio', probe.hasAudio)

  if (!oldPrompt) {
    try {
      oldPrompt = await scenePromptFromFrame(probe.frames[0])
    } catch (err) {
      console.warn('legacy prompt failed:', err instanceof Error ? err.message : err)
    }
  }

  const spec = await extractSceneSpec(probe, videoUrl)
  const rendered = renderScenePrompt(spec)

  console.log('\n=== SCENE SPEC ===')
  console.log(JSON.stringify(spec, null, 2))
  console.log('\n=== OLD PROMPT ===')
  console.log(oldPrompt ?? '(none)')
  console.log('\n=== NEW RENDERED PROMPT ===')
  console.log(rendered)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
