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
 * ── How terms are matched, and why ──────────────────────────────────────────
 * Measured against the live library, all three settings on the same corpus:
 *
 *   LIKE '%term%'    6982 of 9120 hidden (77%)  -- 'art' inside "smart"/"start"
 *                                                  /"heart", 'man'/'men' inside
 *                                                  "woman"/"women" (7933 rows)
 *   both ends \y..\y 2429 hidden                -- but "cyberpunk" survives a
 *                                                  sweep for "cyber", and
 *                                                  "monochromatic" survives
 *                                                  "monochrome"
 *   word-start \y..  the setting used here
 *
 * A prefix cannot match mid-word, so start/smart/heart are still safe, while a
 * term reaches the whole family of words built on it. The exceptions below and
 * STRICT_TERMS cover the cases where that reaches too far.
 */
import pg from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Matched as word *prefixes*: the term must start a word, but the word may
 * continue. "cyber" catches cyberpunk, "monochrom" catches monochromatic,
 * "india" catches indian. Several entries are deliberately stems rather than
 * whole words for that reason.
 *
 * A prefix cannot hit mid-word, so start/smart/heart still survive "art".
 */
const TERMS = [
  // first sweep
  'futuristic', 'paint', 'art', 'cyber', 'exposure', 'cosmic', 'mural',
  'alphabet', 'fragment', 'monochrom', 'product', 'cluster', '3D',
  'handwritten', 'text overlay', 'commercial',
  // second sweep
  'multi panel', 'movie style', 'india', 'post apocalyptic', 'golden hour',
  'mother of dragons', 'occult', 'brutalis', 'propert',
]

/**
 * Whole-word only. These are too short to prefix safely: "man" would take
 * many/management/mansion, "men" would take menu/mental/mention.
 */
const STRICT_TERMS = ['man', 'men']

/**
 * Continuations that turn a prefix into an unrelated word.
 *
 * "art" is the one that matters: a bare \yart also takes "artificial", which
 * 222 rows use in the photographic sense ("no artificial lighting") and which
 * has nothing to do with art as a style. Measured, not guessed — dropping this
 * exception hid ordinary portrait prompts.
 */
const PREFIX_EXCEPTIONS = {
  art: ['ificial', 'icle'],
}

const env = readFileSync('.env.local', 'utf8')
for (const line of env.split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 0) continue
  process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
}

/**
 * Postgres ARE patterns.
 *
 * - Spaces in a term match a space or a hyphen, so "multi panel" also catches
 *   "multi-panel" and "post apocalyptic" catches "post-apocalyptic" — these are
 *   spelled both ways across the corpus and nobody should have to list each.
 * - TERMS anchor at a word start only, so the word may continue. Anchoring both
 *   ends is what let "cyberpunk" survive a sweep for "cyber".
 * - STRICT_TERMS anchor both ends, and man/men also exclude a preceding hyphen
 *   or "Spider-Man" reads as a man.
 */
const pattern = t => {
  const body = t.trim().split(/\s+/).join('[- ]')
  if (STRICT_TERMS.includes(t)) return '(?<!-)\\y' + body + '\\y'
  const except = PREFIX_EXCEPTIONS[t]
  return '\\y' + body + (except ? `(?!${except.join('|')})` : '')
}

const ALL_TERMS = [...TERMS, ...STRICT_TERMS]

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

const ors = ALL_TERMS.map((_, i) => `(title ~* $${i + 1} or prompt ~* $${i + 1})`).join(' or ')
const params = ALL_TERMS.map(pattern)

const total = await c.query('select count(*)::int n from scraped_prompts where is_active')
console.log(`active prompts: ${total.rows[0].n}\n`)

for (const t of ALL_TERMS) {
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
writeFileSync(backup, JSON.stringify({ terms: ALL_TERMS, ids: hit.rows.map(r => r.id) }, null, 2))

const upd = await c.query(
  `update scraped_prompts set is_active = false where is_active and (${ors})`,
  params,
)
const left = await c.query('select count(*)::int n from scraped_prompts where is_active')
console.log(`\nhidden: ${upd.rowCount}   active now: ${left.rows[0].n}`)
console.log(`backup: ${backup}  (reverse with --restore ${backup})`)

await c.end()
