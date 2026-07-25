/**
 * Prints the monitor pipeline state per discovery item, mirroring what the
 * Copy-Paste > Replicate tab queries, so UI visibility can be checked without a browser.
 *
 * Usage: npx tsx scripts/monitor-status.ts [username]
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

const username = process.argv[2]

async function main() {
  const { rows } = await import('../src/lib/db')

  const items = await rows<{
    email: string
    profile: string
    content_url: string
    admin_status: string
    replicate_status: string
    content_type: string | null
    video_technique: string | null
    technique_confidence: number | null
    source_duration: number | null
    source_cut_count: number | null
    video_model: string | null
    generated_image_url: string | null
    kling_video_url: string | null
  }>(
    `SELECT u.email, d.profile, d.content_url, d.admin_status, d.replicate_status,
            d.content_type, d.video_technique, d.technique_confidence,
            d.source_duration, d.source_cut_count, d.video_model,
            d.generated_image_url, d.kling_video_url
       FROM discovery_items d
       JOIN users u ON u.id = d.user_id
      WHERE d.video_technique IS NOT NULL
        AND ($1::text IS NULL OR lower(d.profile) = lower($1))
      ORDER BY d.discovered_at DESC
      LIMIT 25`,
    [username ?? null],
  )

  if (!items.length) {
    console.log('No classified monitor items yet.')
    process.exit(0)
  }

  for (const it of items) {
    // The Replicate tab only lists approved items, and splits them by replicate_status.
    const visibleUnder =
      it.admin_status !== 'APPROVED' ? 'NOT VISIBLE (not approved)'
      : it.replicate_status === 'done' ? 'Replicate tab > "done"'
      : it.replicate_status === 'needs_review' ? 'Replicate tab > "review"'
      : it.replicate_status === 'failed' ? 'Replicate tab > "failed"'
      : ['none', 'pending_classify', 'classified'].includes(it.replicate_status)
        ? 'Replicate tab > "pending"'
        : 'Replicate tab > "active"'

    console.log(`─── @${it.profile}  ${it.content_url}`)
    console.log(`  owner     : ${it.email}`)
    console.log(`  status    : ${it.replicate_status}  (admin: ${it.admin_status})`)
    console.log(`  content   : ${it.content_type}`)
    console.log(`  technique : ${it.video_technique}`
      + (it.technique_confidence != null ? ` @ ${Math.round(it.technique_confidence * 100)}%` : ''))
    console.log(`  measured  : ${it.source_duration?.toFixed?.(1) ?? '?'}s, ${it.source_cut_count ?? '?'} cuts`)
    if (it.video_model) console.log(`  model     : ${it.video_model}`)
    if (it.generated_image_url) console.log(`  image     : ${it.generated_image_url}`)
    if (it.kling_video_url) console.log(`  video     : ${it.kling_video_url}`)
    console.log(`  UI        : ${visibleUnder}\n`)
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
