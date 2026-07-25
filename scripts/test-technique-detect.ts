/**
 * Scans a tracked profile for a few recent posts and runs technique detection on them.
 * Detection only — no image or video generation, so this costs a handful of Grok calls.
 *
 * Usage: npx tsx scripts/test-technique-detect.ts [username] [count]
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '..', '.env.local') })

const username = process.argv[2] ?? 'gracie.bestie_'
const count = Number(process.argv[3] ?? 3)

async function main() {
  // Imported after env is loaded — these modules read process.env at module scope.
  const { one, rows, query } = await import('../src/lib/db')
  const { scanTrackedProfile } = await import('../src/lib/monitor/scan')
  const { classifyDiscoveryItem } = await import('../src/lib/monitor/process-item')
  const { getTechnique } = await import('../src/lib/monitor/techniques')
  type TrackedProfileRow = import('../src/lib/monitor/types').TrackedProfileRow

  let profile = await one<TrackedProfileRow>(
    `SELECT * FROM tracked_profiles
      WHERE lower(username) = lower($1) AND platform = 'Instagram'
      ORDER BY created_at NULLS LAST LIMIT 1`,
    [username],
  )

  if (!profile) {
    const owner = await one<{ id: string; email: string }>(
      `SELECT id, email FROM users ORDER BY created_at LIMIT 1`,
    )
    if (!owner) throw new Error('No users in database')

    console.log(`No tracked profile for @${username} — creating one for ${owner.email}`)
    profile = await one<TrackedProfileRow>(
      `INSERT INTO tracked_profiles
         (user_id, platform, username, min_score, max_age_days, status, autopilot)
       VALUES ($1, 'Instagram', $2, 0, 30, 'ACTIVE', false)
       RETURNING *`,
      [owner.id, username],
    )
    if (!profile) throw new Error('Could not create tracked profile')
  }

  console.log(`\nScanning @${profile.username} for ${count} recent post(s)…`)
  const scan = await scanTrackedProfile(profile.user_id, profile, { resultsLimit: count })
  console.log(`Listed via ${scan.source}: scanned ${scan.scanned}, newly added ${scan.added}\n`)

  // Re-runs add nothing new, so operate on the most recent stored items instead.
  const items = await rows<{ id: string; content_url: string; video_url: string | null }>(
    `SELECT id, content_url, video_url FROM discovery_items
      WHERE user_id = $1 AND lower(profile) = lower($2)
      ORDER BY posted_at DESC NULLS LAST
      LIMIT $3`,
    [profile.user_id, profile.username, count],
  )

  if (!items.length) {
    console.log('No stored items for this profile — the scan returned nothing usable.')
    console.log('Check APIFY_API_KEY and that the profile is public.')
    return
  }

  for (const [i, item] of items.entries()) {
    console.log(`─── ${i + 1}/${items.length}  ${item.content_url}`)
    if (!item.video_url) console.log('   (no video URL resolved — needs RAPIDAPI_KEY for this user)')

    try {
      await classifyDiscoveryItem(item.id, profile.user_id)
      const row = await one<{
        content_type: string | null
        video_technique: string | null
        technique_confidence: number | null
        technique_reasoning: string | null
        source_duration: number | null
        source_cut_count: number | null
        replicate_status: string
      }>(
        `SELECT content_type, video_technique, technique_confidence, technique_reasoning,
                source_duration, source_cut_count, replicate_status
           FROM discovery_items WHERE id = $1`,
        [item.id],
      )
      if (!row) continue

      const spec = getTechnique(row.video_technique as never)
      console.log(`   content type : ${row.content_type}`)
      console.log(`   technique    : ${row.video_technique} (${spec.label})`
        + (row.technique_confidence != null ? ` @ ${Math.round(row.technique_confidence * 100)}%` : ''))
      console.log(`   measured     : ${row.source_duration?.toFixed?.(1) ?? '?'}s, ${row.source_cut_count ?? '?'} cuts`)
      console.log(`   routes to    : ${spec.model ?? `NOT EXECUTABLE — ${spec.reviewReason}`}`)
      console.log(`   status       : ${row.replicate_status}`)
      console.log(`   reasoning    : ${row.technique_reasoning}\n`)
    } catch (err) {
      console.log(`   FAILED: ${err instanceof Error ? err.message : err}\n`)
    }
  }

  await query('SELECT 1')
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
