/**
 * Copy pins from an already-imported Pinterest board into pose_library.
 * Reuses xxmachine's existing Pinterest import (Copy Prompts -> Pinterest
 * tab) — this script never talks to Pinterest itself, only reads
 * pinterest_pins that board import already wrote.
 *
 *   npx tsx scripts/import-pinterest-to-pose-library.ts --board "IG bot - Stories" --format stories [--nsfw] [--category NAME] [--user EMAIL]
 *
 * --board matches pinterest_boards.title case-insensitively (exact match).
 * FORMAT is one of: posts, stories, carousels, fanvue_sfw, fanvue_nsfw, reels.
 * Skips pins whose image_url_hd is already in pose_library for this user, so
 * re-running after adding more pins to the same board only imports the new ones.
 */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const VALID_FORMATS = ['posts', 'stories', 'carousels', 'fanvue_sfw', 'fanvue_nsfw', 'reels']

function parseArgs(argv: string[]) {
  let board: string | null = null
  let format: string | null = null
  let category: string | null = null
  let nsfw = false
  let userEmail = 'novakovicbbrs@gmail.com'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--board') board = argv[++i] ?? null
    else if (argv[i] === '--format') format = argv[++i] ?? null
    else if (argv[i] === '--category') category = argv[++i] ?? null
    else if (argv[i] === '--nsfw') nsfw = true
    else if (argv[i] === '--user') userEmail = argv[++i] ?? userEmail
  }
  if (format === 'fanvue_nsfw') nsfw = true
  return { board, format, category, nsfw, userEmail }
}

async function main() {
  const { board, format, category, nsfw, userEmail } = parseArgs(process.argv.slice(2))
  if (!board || !format || !VALID_FORMATS.includes(format)) {
    console.error(
      'usage: npx tsx scripts/import-pinterest-to-pose-library.ts --board "TITLE" --format FORMAT [--nsfw] [--category NAME] [--user EMAIL]\n' +
      `FORMAT must be one of: ${VALID_FORMATS.join(', ')}`,
    )
    process.exit(1)
  }

  const { one, rows, query } = await import('../src/lib/db')

  const user = await one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail])
  if (!user) throw new Error(`No user with email ${userEmail}`)

  const boardRow = await one<{ id: string; title: string; pin_count: number }>(
    `SELECT id, title, pin_count FROM pinterest_boards WHERE user_id = $1 AND lower(title) = lower($2)`,
    [user.id, board],
  )
  if (!boardRow) throw new Error(`No Pinterest board titled "${board}" for ${userEmail}`)

  const pins = await rows<{ id: string; image_url_hd: string }>(
    `SELECT id, image_url_hd FROM pinterest_pins WHERE board_id = $1 AND is_active = true`,
    [boardRow.id],
  )
  if (!pins.length) throw new Error(`Board "${boardRow.title}" has no active pins`)

  console.log(`Board "${boardRow.title}": ${pins.length} pin(s) -> format=${format} nsfw=${nsfw} category=${category ?? 'none'}`)

  let imported = 0
  let skipped = 0
  for (const pin of pins) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM pose_library WHERE user_id = $1 AND image_url = $2`,
      [user.id, pin.image_url_hd],
    )
    if (existing) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO pose_library (user_id, image_url, category, nsfw, content_format) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, pin.image_url_hd, category, nsfw, format],
    )
    imported++
  }

  console.log(`\n${imported} imported, ${skipped} already present.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
