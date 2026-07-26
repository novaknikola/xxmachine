import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

const jobId = process.argv[2] ?? '7b4af81e-a9a9-44a1-858b-7a9adb69a163'
const itemId = process.argv[3] ?? 'c38ba198-7f76-4401-9e94-46686be8572c'

async function main() {
  const { one, query } = await import('../src/lib/db')
  const { processMultiShotJob } = await import('../src/lib/monitor/multi-shot')

  await query(
    `UPDATE generation_queue
        SET status = 'processing',
            started_at = COALESCE(started_at, now()),
            attempts = GREATEST(attempts, 1)
      WHERE id = $1`,
    [jobId],
  )

  const job = await one<{
    user_id: string
    input: import('../src/lib/monitor/multi-shot').MonitorMultiShotJobInput
    done_items: number
    output: import('../src/lib/monitor/multi-shot').MonitorMultiShotJobOutput | null
  }>(
    `SELECT user_id, input, done_items, output FROM generation_queue WHERE id = $1`,
    [jobId],
  )
  if (!job) throw new Error('job missing')

  console.log('processing', jobId)
  const out = await processMultiShotJob({
    jobId,
    userId: job.user_id,
    input: job.input,
    doneItems: job.done_items,
    existingOutput: job.output,
  })

  const disc = await one(
    `SELECT replicate_status, kling_video_url, generated_image_url, video_model
       FROM discovery_items WHERE id = $1`,
    [itemId],
  )
  console.log(JSON.stringify({ out, disc }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
