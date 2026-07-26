/**
 * End-to-end multi-shot replication on the existing Gracie multi_shot item.
 *
 *   npx tsx scripts/test-multi-shot.ts
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

async function main() {
  const { one, query, rows } = await import('../src/lib/db')
  const { replicateDiscoveryItem } = await import('../src/lib/monitor/process-item')
  const {
    processMultiShotJob,
  } = await import('../src/lib/monitor/multi-shot')
  type MonitorMultiShotJobInput = import('../src/lib/monitor/multi-shot').MonitorMultiShotJobInput
  type MonitorMultiShotJobOutput = import('../src/lib/monitor/multi-shot').MonitorMultiShotJobOutput

  const items = await rows<{
    id: string
    user_id: string
    profile: string
    admin_status: string
    replicate_status: string
    video_technique: string | null
    source_cut_count: number | null
    has_vid: boolean
    has_img: boolean
    character_id: string | null
  }>(
    `SELECT di.id, di.user_id, di.profile, di.admin_status, di.replicate_status,
            di.video_technique, di.source_cut_count,
            (di.video_url IS NOT NULL) AS has_vid,
            (di.generated_image_url IS NOT NULL) AS has_img,
            tp.character_id
       FROM discovery_items di
       LEFT JOIN tracked_profiles tp
         ON tp.user_id = di.user_id
        AND tp.username = di.profile
        AND tp.platform = di.platform
      WHERE di.video_technique = 'multi_shot'
         OR COALESCE(di.source_cut_count, 0) >= 1
      ORDER BY di.discovered_at DESC
      LIMIT 5`,
  )

  console.log('candidates:', JSON.stringify(items, null, 2))
  const item = items.find(i => i.video_technique === 'multi_shot') ?? items[0]
  if (!item) throw new Error('No multi-shot candidate found')
  if (!item.character_id) throw new Error('No character bound to profile — bind Tiana first')

  await query(
    `UPDATE discovery_items
        SET admin_status = 'APPROVED',
            replicate_status = CASE
              WHEN generated_image_url IS NOT NULL THEN 'image_done'
              ELSE 'classified'
            END,
            kling_video_url = NULL,
            replicate_error = NULL
      WHERE id = $1`,
    [item.id],
  )

  console.log('replicating', item.id, '@' + item.profile)
  console.log('WAVESPEED set?', Boolean(process.env.WAVESPEED_API_KEY))

  const result = await replicateDiscoveryItem(item.id, item.user_id)
  console.log('enqueue result:', JSON.stringify(result, null, 2))

  if (!(result as { queued?: boolean }).queued) {
    console.log('Did not queue — technique may have fallen back. Stopping.')
    return
  }

  const jobId = (result as { jobId: string }).jobId
  console.log('running job inline', jobId)

  await query(
    `UPDATE generation_queue
        SET status = 'processing', started_at = COALESCE(started_at, now()),
            attempts = GREATEST(attempts, 1)
      WHERE id = $1`,
    [jobId],
  )

  const job = await one<{
    user_id: string
    input: MonitorMultiShotJobInput
    done_items: number
    output: MonitorMultiShotJobOutput | null
  }>(
    `SELECT user_id, input, done_items, output FROM generation_queue WHERE id = $1`,
    [jobId],
  )
  if (!job) throw new Error('Job row missing')

  const out = await processMultiShotJob({
    jobId,
    userId: job.user_id,
    input: job.input,
    doneItems: job.done_items,
    existingOutput: job.output,
  })

  const disc = await one<{
    replicate_status: string
    kling_video_url: string | null
    video_model: string | null
    generated_image_url: string | null
  }>(
    `SELECT replicate_status, kling_video_url, video_model, generated_image_url
       FROM discovery_items WHERE id = $1`,
    [item.id],
  )

  console.log('DONE', { ...out, item: disc })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
