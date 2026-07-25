/**
 * Runs technique detection against video URLs directly, bypassing the scraper.
 * Either pass a video URL, or omit it to reuse stored discovery items.
 *
 * Usage: npx tsx scripts/test-technique-url.ts [videoUrl]
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '..', '.env.local') })

const directUrl = process.argv[2]

async function main() {
  const { rows } = await import('../src/lib/db')
  const { probeSourceVideo } = await import('../src/lib/monitor/analyze')
  const { analyzeVideoContent } = await import('../src/lib/monitor/classify')
  const { getTechnique } = await import('../src/lib/monitor/techniques')

  let targets: { label: string; url: string }[]

  if (directUrl) {
    targets = [{ label: 'argument', url: directUrl }]
  } else {
    const stored = await rows<{ profile: string; content_url: string; video_url: string }>(
      `SELECT profile, content_url, video_url FROM discovery_items
        WHERE video_url IS NOT NULL AND video_url <> ''
        ORDER BY discovered_at DESC LIMIT 5`,
    )
    targets = stored.map(s => ({ label: `@${s.profile} ${s.content_url}`, url: s.video_url }))
  }

  if (!targets.length) {
    console.log('Nothing to test: no video URL given and no stored items carry one.')
    process.exit(0)
  }

  console.log(`Testing technique detection on ${targets.length} clip(s)\n`)

  for (const [i, target] of targets.entries()) {
    console.log(`─── ${i + 1}/${targets.length}  ${target.label}`)
    try {
      const probe = await probeSourceVideo(target.url, 5)
      if (!probe) {
        console.log('   could not download or probe the clip (expired CDN link?)\n')
        continue
      }
      console.log(`   measured  : ${probe.duration?.toFixed(1) ?? '?'}s, ${probe.cutCount} cuts, `
        + `audio ${probe.hasAudio ? 'yes' : 'no'}, ${probe.frames.length} frames`)

      const analysis = await analyzeVideoContent(probe)
      const spec = getTechnique(analysis.video_technique)
      console.log(`   content   : ${analysis.content_type}`)
      console.log(`   technique : ${analysis.video_technique} @ ${Math.round(analysis.technique_confidence * 100)}%`
        + (analysis.overrodeModel ? ' (measured signal overrode the model)' : ''))
      console.log(`   routes to : ${spec.model ?? `NOT EXECUTABLE — ${spec.reviewReason}`}`)
      console.log(`   reasoning : ${analysis.reasoning}\n`)
    } catch (err) {
      console.log(`   FAILED: ${err instanceof Error ? err.message : err}\n`)
    }
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
