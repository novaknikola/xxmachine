/**
 * Hide scraped_prompts whose title or prompt contains an unwanted term.
 *
 *   node scripts/hide-scraped-prompt-terms.mjs              # dry run, prints counts
 *   node scripts/hide-scraped-prompt-terms.mjs --apply      # sets is_active = false
 *   node scripts/hide-scraped-prompt-terms.mjs --restore <backup.json>
 *
 * The scrapers keep importing, so new prompts carrying these terms appear over
 * time -- this is meant to be re-run, not a one-off.
 *
 * Nothing is deleted: rows are flipped to is_active = false, which is the only
 * thing /api/scraped-prompts filters on. Every apply writes the affected ids to
 * a backup file so a run can be reversed exactly.
 *
 * ── Why word boundaries, not LIKE '%term%' ──────────────────────────────────
 * Measured against the live library (9120 active rows):
 *
 *   substring:      6982 hidden (77%)   -- 'art' inside "portrait" (3313 rows),
 *                                          'man'/'men' inside "woman"/"women"
 *                                          (7933 rows)
 *   word boundary:  2429 hidden
 *
 * man/men additionally exclude a preceding hyphen, or "Spider-Man" counts as a
 * man -- that alone caught 14 female-subject cosplay prompts.
 */
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'

const TERMS = [
  // first sweep
  'futuristic', 'paint', 'art', 'cyber', 'exposure', 'painterly', 'men', 'man',
  'cosmic', 'mural', 'alphabet', 'fragments', 'monochrome', 'product', 'cluster',
  '3D', 'handwritten', 'text overlay', 'Commercial',
  // second sweep — multi-word entries also match their hyphenated spelling
  'multi panel', 'movie style', 'india', 'indian', 'post apocalyptic',
  'golden hour', 'mother of dragons', 'occult', 'brutalist', 'property',
]

const env = readFileSync('.env.local', 'utf8')
for (const line of env.split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 0) continue
  process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}

/**
 * Postgres ARE word-boundary match.
 *
 * - Spaces in a term match a space or a hyphen, so "multi panel" also catches
 *   "multi-panel" and "post apocalyptic" catches "post-apocalyptic" — these are
 *   spelled both ways across the corpus and nobody should have to list each.
 * - man/men additionally exclude a preceding hyphen, or "Spider-Man" reads as
 *   a man.
 */
const pattern = t => {
  const body = t.trim().split(/\s+/).join('[- ]')
  if (t === 'man' || t === 'men') return '(?<!-)\\y' + body + '\\y'
  return '\\y' + body + '\\y'
}

const apply = process.argv.includes('--apply')
const restoreIdx = process.argv.indexOf('--restore')

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

if (restoreIdx !== -1) {
  const file = process.argv[restoreIdx + 1]
  if (!file) { console.error('--restore needs a backup file'); process.exit(1) }
  const { ids } = JSON.parse(readFileSync(file, 'utf8'))
  const res = await c.query(
    'update scraped_prompts set is_active = true where id = any($1::uuid[]) and is_active = false',
    [ids],
  )
  console.log(`restored ${res.rowCount} of ${ids.length} from ${file}`)
  await c.end()
  process.exit(0)
}

const ors = TERMS.map((_, i) => `(title ~* $${i + 1} or prompt ~* $${i + 1})`).join(' or ')
const params = TERMS.map(pattern)

const total = await c.query('select count(*)::int n from scraped_prompts where is_active')
console.log(`active prompts: ${total.rows[0].n}\n`)

for (const t of TERMS) {
  const r = await c.query(
    'select count(*)::int n from scraped_prompts where is_active and (title ~* $1 or prompt ~* $1)',
    [pattern(t)],
  )
  if (r.rows[0].n) console.log(`  ${t.padEnd(15)} ${r.rows[0].n}`)
}

const hit = await c.query(`select id from scraped_prompts where is_active and (${ors})`, params)
console.log(`\nmatched: ${hit.rows.length}   would remain: ${total.rows[0].n - hit.rows.length}`)

if (!apply) {
  console.log('\ndry run — pass --apply to hide them')
  await c.end()
  process.exit(0)
}

const backup = `scraped-prompts-hidden-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(backup, JSON.stringify({ terms: TERMS, ids: hit.rows.map(r => r.id) }, null, 2))

const upd = await c.query(
  `update scraped_prompts set is_active = false where is_active and (${ors})`,
  params,
)
const left = await c.query('select count(*)::int n from scraped_prompts where is_active')
console.log(`\nhidden: ${upd.rowCount}   active now: ${left.rows[0].n}`)
console.log(`backup: ${backup}  (reverse with --restore ${backup})`)

await c.end()
