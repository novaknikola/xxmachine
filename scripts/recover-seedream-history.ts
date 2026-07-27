/**
 * Recovers Seedream edit outputs that WaveSpeed produced but our History never
 * stored (the pre-fix `/api/edit-image` history write failed silently on auth).
 *
 * Reads completed Seedream edit predictions from the WaveSpeed billing log,
 * re-uploads the still-reachable outputs to Storage and inserts `generations`
 * rows stamped with the original prediction time. WaveSpeed does not return the
 * request input, so the original prompt cannot be recovered — rows are labelled
 * with the prediction id instead.
 *
 * Usage: npx tsx scripts/recover-seedream-history.ts [hours] [--dry] [--email=a@b.c]
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

const API = 'https://api.wavespeed.ai/api/v3'
const CONCURRENCY = 5
const PROMPT_PREFIX = 'Recovered Seedream edit · wavespeed:'

const args = process.argv.slice(2)
const hours = Number(args.find(a => /^\d+$/.test(a)) ?? 48)
const dryRun = args.includes('--dry')
const email = args.find(a => a.startsWith('--email='))?.slice('--email='.length)

interface Billing {
  created_at: string
  prediction?: { model_uuid?: string; uuid?: string; status?: string }
}

function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY
  if (!key) throw new Error('WAVESPEED_API_KEY is not set')
  return key
}

async function billingsPage(page: number): Promise<Billing[]> {
  const res = await fetch(`${API}/billings/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wavespeedKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page, page_size: 50, sort: 'created_at DESC', billing_type: 'deduct' }),
  })
  const json = await res.json()
  if (json.code && json.code !== 200) throw new Error(json.message ?? 'billings/search failed')
  return json?.data?.items ?? []
}

async function collectPredictions(cutoff: number): Promise<Billing[]> {
  const found: Billing[] = []
  for (let page = 1; page <= 60; page++) {
    const items = await billingsPage(page)
    if (!items.length) break

    let reachedCutoff = false
    for (const item of items) {
      if (new Date(item.created_at).getTime() < cutoff) {
        reachedCutoff = true
        break
      }
      const model = item.prediction?.model_uuid ?? ''
      if (
        model.includes('seedream') &&
        model.includes('edit') &&
        item.prediction?.status === 'completed' &&
        item.prediction.uuid
      ) {
        found.push(item)
      }
    }
    if (reachedCutoff) break
  }
  return found
}

async function predictionOutputs(id: string): Promise<string[]> {
  const res = await fetch(`${API}/predictions/${id}/result`, {
    headers: { Authorization: `Bearer ${wavespeedKey()}` },
  })
  const json = await res.json()
  const outputs = json?.data?.outputs
  return Array.isArray(outputs) ? outputs.filter((u: unknown) => typeof u === 'string') : []
}

async function main() {
  const { rows, query } = await import('../src/lib/db')
  const { persistGeneration } = await import('../src/lib/persist-generation')

  const users = await rows<{ id: string; email: string; n: number }>(
    `SELECT u.id, u.email, COUNT(g.id)::int AS n
       FROM users u LEFT JOIN generations g ON g.user_id::text = u.id::text
      ${email ? 'WHERE u.email = $1' : ''}
      GROUP BY u.id, u.email
      ORDER BY n DESC`,
    email ? [email] : [],
  )
  const target = users[0]
  if (!target) throw new Error(email ? `No user with email ${email}` : 'No users found')
  console.log(`recovering into account: ${target.email} (${target.id})`)

  const cutoff = Date.now() - hours * 3600 * 1000
  const predictions = await collectPredictions(cutoff)
  console.log(`completed Seedream edit predictions in last ${hours}h: ${predictions.length}`)

  const stats = { recovered: 0, skippedKnown: 0, expired: 0, failed: 0, noOutput: 0 }
  let cursor = 0

  async function worker() {
    while (cursor < predictions.length) {
      const index = cursor++
      const item = predictions[index]
      const id = item.prediction!.uuid!

      try {
        const outputs = await predictionOutputs(id)
        if (!outputs.length) {
          stats.noOutput++
          continue
        }

        const known = await rows<{ hit: number }>(
          `SELECT 1 AS hit FROM generations
            WHERE image_urls && $1::text[] OR prompt LIKE $2
           UNION ALL
           SELECT 1 AS hit FROM discovery_items
            WHERE generated_image_url = ANY($1::text[])
               OR generated_end_image_url = ANY($1::text[])
           LIMIT 1`,
          [outputs, `${PROMPT_PREFIX}${id}%`],
        )
        if (known.length) {
          stats.skippedKnown++
          continue
        }

        const head = await fetch(outputs[0], { method: 'HEAD' })
        if (!head.ok) {
          stats.expired++
          continue
        }

        if (dryRun) {
          stats.recovered++
          continue
        }

        await persistGeneration({
          kind: 'seedream_edit',
          prompt: `${PROMPT_PREFIX}${id} (original prompt not stored by the provider)`,
          wavespeedUrls: outputs,
          userId: target.id,
          createdAt: item.created_at,
        })
        stats.recovered++
      } catch (err) {
        stats.failed++
        console.error(`  ! ${id}: ${err instanceof Error ? err.message : err}`)
      }

      const done = stats.recovered + stats.skippedKnown + stats.expired + stats.failed + stats.noOutput
      if (done % 25 === 0) {
        console.log(`  progress ${done}/${predictions.length} ${JSON.stringify(stats)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\n${dryRun ? 'DRY RUN — nothing written' : 'done'}:`, stats)
  await query('SELECT 1')
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
