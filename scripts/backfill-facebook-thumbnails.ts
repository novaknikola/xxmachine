// One-off / rerunnable catch-up: fills caption+thumbnail for any
// facebook_queue row still missing one, across every page. Same worker
// pool src/lib/facebook/enrich.ts uses after Sync Drive and the daily
// auto-schedule — this script exists for a manual "run it right now
// without waiting on a request" pass.
import { config as loadEnv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '..', '.env.local') })

import { rows } from '@/lib/db'
import { enrichPendingFacebookQueueItems } from '@/lib/facebook/enrich'

async function main() {
  if (!process.env.FFMPEG_PATH) {
    console.error('FFMPEG_PATH not set in .env.local')
    process.exit(1)
  }

  const pages = await rows<{ id: string; name: string }>(`SELECT id, name FROM facebook_pages`)
  for (const page of pages) {
    const { processed, failed } = await enrichPendingFacebookQueueItems(page.id)
    console.log(`${page.name}: ${processed} enriched, ${failed} failed`)
  }
  process.exit(0)
}

main()
