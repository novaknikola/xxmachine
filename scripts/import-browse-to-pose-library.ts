/**
 * Copy Browse tab (scraped_prompts, youmind source) preview images into
 * pose_library, filtered down to realistic selfie/portrait content only —
 * excludes stylized/art content and grid/multi-panel layouts per the user's
 * explicit requirement. Keyword-based, not perfect: real-named-celebrity
 * prompts are NOT filtered out (acknowledged, user's explicit call).
 *
 *   npx tsx scripts/import-browse-to-pose-library.ts --format posts [--nsfw] [--user EMAIL] [--strict|--broad]
 *
 * --strict (default): title/prompt must also mention selfie/portrait/
 *   photorealistic/candid. --broad: only the exclude list applies.
 */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const VALID_FORMATS = ['posts', 'stories', 'carousels', 'fanvue_sfw', 'fanvue_nsfw', 'reels']

const EXCLUDE = [
  'art', 'illustration', 'anime', 'cyberpunk', 'fantasy', 'sci-fi', 'scifi', 'painting', 'cartoon',
  'digital art', '3d render', '\\brender\\b', 'concept art', 'stylized', 'surreal', 'abstract',
  'watercolor', 'sketch', 'comic', 'manga', 'pixel art', 'vector', 'fanart', 'cgi', 'game character',
  'diorama',
  'grid', 'multibox', 'multi-box', 'collage', 'comparison', 'before and after', 'before/after',
  'diptych', 'triptych', 'mosaic', 'split screen', 'side by side', 'panel', 'sheet', 'contact sheet',
]
const INCLUDE = ['selfie', 'portrait', 'photorealistic', 'realistic photo', 'candid']

function parseArgs(argv: string[]) {
  let format: string | null = null
  let nsfw = false
  let userEmail = 'novakovicbbrs@gmail.com'
  let strict = true
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format') format = argv[++i] ?? null
    else if (argv[i] === '--nsfw') nsfw = true
    else if (argv[i] === '--user') userEmail = argv[++i] ?? userEmail
    else if (argv[i] === '--broad') strict = false
    else if (argv[i] === '--strict') strict = true
  }
  return { format, nsfw, userEmail, strict }
}

async function main() {
  const { format, nsfw, userEmail, strict } = parseArgs(process.argv.slice(2))
  if (!format || !VALID_FORMATS.includes(format)) {
    console.error(
      'usage: npx tsx scripts/import-browse-to-pose-library.ts --format FORMAT [--nsfw] [--user EMAIL] [--strict|--broad]\n' +
      `FORMAT must be one of: ${VALID_FORMATS.join(', ')}`,
    )
    process.exit(1)
  }

  const { one, rows, query } = await import('../src/lib/db')
  const user = await one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail])
  if (!user) throw new Error(`No user with email ${userEmail}`)

  const excludeRe = EXCLUDE.join('|')
  const includeRe = INCLUDE.join('|')

  const candidates = strict
    ? await rows<{ id: string; preview_image_url: string; title: string | null }>(
        `SELECT id, preview_image_url, title FROM scraped_prompts
          WHERE is_active = true AND preview_image_url IS NOT NULL
            AND NOT (title ~* $1 OR prompt ~* $1)
            AND (title ~* $2 OR prompt ~* $2)`,
        [excludeRe, includeRe],
      )
    : await rows<{ id: string; preview_image_url: string; title: string | null }>(
        `SELECT id, preview_image_url, title FROM scraped_prompts
          WHERE is_active = true AND preview_image_url IS NOT NULL
            AND NOT (title ~* $1 OR prompt ~* $1)`,
        [excludeRe],
      )

  console.log(`${candidates.length} candidate(s) (${strict ? 'strict' : 'broad'} filter) -> format=${format} nsfw=${nsfw}`)

  let imported = 0
  let skipped = 0
  for (const c of candidates) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM pose_library WHERE user_id = $1 AND image_url = $2 AND content_format = $3`,
      [user.id, c.preview_image_url, format],
    )
    if (existing) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO pose_library (user_id, image_url, category, nsfw, content_format) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, c.preview_image_url, c.title, nsfw, format],
    )
    imported++
  }

  console.log(`\n${imported} imported, ${skipped} already present.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
