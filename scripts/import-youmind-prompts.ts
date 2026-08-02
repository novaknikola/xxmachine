/**
 * Imports scraped youmind prompts into the scraped_prompts table.
 *
 * Usage: npx tsx scripts/import-youmind-prompts.ts
 * Reads:  prompts/youmind/youmind_prompts_merged.jsonl
 * Writes: scraped_prompts table (idempotent upsert on (source, source_id))
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IN_PATH = resolve(ROOT, 'prompts', 'youmind', 'youmind_prompts_merged.jsonl')
const BATCH_SIZE = 500
const MAX_PROMPT_LEN = 6000

interface YoumindRecord {
  id: string
  title: string | null
  prompt: string | null
  url?: string | null
  sourceLink?: string | null
  author?: string | null
  sourceMedia?: string[] | null
}

interface Row {
  source: string
  source_id: string
  source_rank: number
  title: string | null
  prompt: string
  raw_prompt: string
  has_template_args: boolean
  author: string | null
  source_url: string | null
  source_link: string | null
  preview_image_url: string | null
  media_urls: string[]
  is_active: boolean
}

// youmind's own remix-template syntax: {argument name="X" default="Y"}
const ARG_RE = /\{argument\s+name="([^"]*)"\s+default="([^"]*)"\}/g

function resolveTemplateArgs(raw: string): { prompt: string; hasArgs: boolean } {
  let hasArgs = false
  const prompt = raw
    .replace(ARG_RE, (_m, name: string, def: string) => {
      hasArgs = true
      return def.trim() || name.trim()
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { prompt, hasArgs }
}

function looksLikeJunk(s: string): boolean {
  const t = s.trim()
  if (!t || t.length < 10) return true
  // A leading '{' is NOT junk here — a large share of youmind's prompts are
  // legitimate structured-JSON scene descriptions (e.g. {"subject": "...",
  // "environment": "..."}), not config/analysis dumps. Only code fences are
  // a reliable junk signal in this corpus.
  if (t.includes('```')) return true
  return false
}

/** Only trims the extreme tail (median prompt length in this corpus is ~978 chars). */
function capLength(s: string): string {
  if (s.length <= MAX_PROMPT_LEN) return s
  const cut = s.slice(0, MAX_PROMPT_LEN)
  const lastComma = cut.lastIndexOf(',')
  return (lastComma > MAX_PROMPT_LEN - 500 ? cut.slice(0, lastComma) : cut).trim()
}

function dedupeKey(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, ' ').slice(0, 180)
}

async function main() {
  const { query } = await import('../src/lib/db')

  const lines = readFileSync(IN_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
  console.log(`Read ${lines.length} lines from ${IN_PATH}`)

  const seen = new Set<string>()
  const rowsOut: Row[] = []
  let junkCount = 0
  let dupCount = 0
  let argsCount = 0

  lines.forEach((line, idx) => {
    let rec: YoumindRecord
    try {
      rec = JSON.parse(line)
    } catch {
      junkCount++
      return
    }
    const rawPrompt = (rec.prompt ?? '').trim()
    if (!rawPrompt) {
      junkCount++
      return
    }

    const { prompt: resolved, hasArgs } = resolveTemplateArgs(rawPrompt)
    if (looksLikeJunk(resolved)) {
      junkCount++
      return
    }
    if (hasArgs) argsCount++

    const prompt = capLength(resolved)
    const key = dedupeKey(prompt)
    const isDup = seen.has(key)
    if (isDup) dupCount++
    else seen.add(key)

    const media = Array.isArray(rec.sourceMedia) ? rec.sourceMedia.filter(Boolean) : []

    rowsOut.push({
      source: 'youmind',
      source_id: String(rec.id),
      source_rank: idx,
      title: rec.title?.trim() || null,
      prompt,
      raw_prompt: rawPrompt,
      has_template_args: hasArgs,
      author: rec.author?.trim() || null,
      source_url: rec.url?.trim() || null,
      source_link: rec.sourceLink?.trim() || null,
      preview_image_url: media[0] ?? null,
      media_urls: media,
      is_active: !isDup,
    })
  })

  console.log(
    `Prepared ${rowsOut.length} rows (junk=${junkCount}, near-dup-suppressed=${dupCount}, with-template-args=${argsCount})`,
  )

  const cols = [
    'source', 'source_id', 'source_rank', 'title', 'prompt', 'raw_prompt',
    'has_template_args', 'author', 'source_url', 'source_link',
    'preview_image_url', 'media_urls', 'is_active',
  ]

  let imported = 0
  for (let i = 0; i < rowsOut.length; i += BATCH_SIZE) {
    const batch = rowsOut.slice(i, i + BATCH_SIZE)
    const values: unknown[] = []
    const tuples = batch.map((r, bi) => {
      const base = bi * cols.length
      values.push(
        r.source, r.source_id, r.source_rank, r.title, r.prompt, r.raw_prompt,
        r.has_template_args, r.author, r.source_url, r.source_link,
        r.preview_image_url, r.media_urls, r.is_active,
      )
      const placeholders = cols.map((_, ci) => `$${base + ci + 1}`)
      placeholders[11] = `${placeholders[11]}::text[]`
      return `(${placeholders.join(', ')})`
    })

    await query(
      `INSERT INTO scraped_prompts (${cols.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (source, source_id) DO UPDATE SET
         title = EXCLUDED.title,
         prompt = EXCLUDED.prompt,
         raw_prompt = EXCLUDED.raw_prompt,
         has_template_args = EXCLUDED.has_template_args,
         author = EXCLUDED.author,
         source_url = EXCLUDED.source_url,
         source_link = EXCLUDED.source_link,
         preview_image_url = EXCLUDED.preview_image_url,
         media_urls = EXCLUDED.media_urls,
         is_active = EXCLUDED.is_active,
         imported_at = now()`,
      values,
    )
    imported += batch.length
    console.log(`  upserted ${imported}/${rowsOut.length}`)
  }

  console.log(`Done. imported=${imported}`)
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
