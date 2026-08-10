/**
 * Copy output images from past copy_prompts_generate jobs (Copy Prompts ->
 * Batches tab) into pose_library. Format is chosen manually via --format,
 * same as import-pinterest-to-pose-library.ts — NOT inherited from whatever
 * format the original job targeted, since every image is just Seedream Edit
 * output and the format tag only controls which pool a future /recreate
 * pick draws from.
 *
 *   npx tsx scripts/import-batches-to-pose-library.ts --format stories [--nsfw] [--category NAME] [--user EMAIL]
 *
 * FORMAT is one of: posts, stories, carousels, fanvue_sfw, fanvue_nsfw, reels.
 * Pulls from every 'done' copy_prompts_generate job for the user — including
 * jobs the pose-recreate bot itself submitted, so past bot output can seed
 * future bot generations too.
 */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const VALID_FORMATS = ['posts', 'stories', 'carousels', 'fanvue_sfw', 'fanvue_nsfw', 'reels']

function parseArgs(argv: string[]) {
  let format: string | null = null
  let category: string | null = null
  let nsfw = false
  let userEmail = 'novakovicbbrs@gmail.com'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format') format = argv[++i] ?? null
    else if (argv[i] === '--category') category = argv[++i] ?? null
    else if (argv[i] === '--nsfw') nsfw = true
    else if (argv[i] === '--user') userEmail = argv[++i] ?? userEmail
  }
  if (format === 'fanvue_nsfw') nsfw = true
  return { format, category, nsfw, userEmail }
}

async function main() {
  const { format, category, nsfw, userEmail } = parseArgs(process.argv.slice(2))
  if (!format || !VALID_FORMATS.includes(format)) {
    console.error(
      'usage: npx tsx scripts/import-batches-to-pose-library.ts --format FORMAT [--nsfw] [--category NAME] [--user EMAIL]\n' +
      `FORMAT must be one of: ${VALID_FORMATS.join(', ')}`,
    )
    process.exit(1)
  }

  const { one, rows, query } = await import('../src/lib/db')

  const user = await one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail])
  if (!user) throw new Error(`No user with email ${userEmail}`)

  const jobs = await rows<{ id: string; output: { copyPromptsRows?: { images: string[] }[] } | null }>(
    `SELECT id, output FROM generation_queue
      WHERE user_id = $1 AND job_type = 'copy_prompts_generate' AND status = 'done'`,
    [user.id],
  )

  const imageUrls = new Set<string>()
  for (const job of jobs) {
    for (const row of job.output?.copyPromptsRows ?? []) {
      for (const url of row.images ?? []) imageUrls.add(url)
    }
  }

  console.log(`${jobs.length} done batch(es), ${imageUrls.size} unique image(s) -> format=${format} nsfw=${nsfw} category=${category ?? 'none'}`)

  let imported = 0
  let skipped = 0
  for (const url of imageUrls) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM pose_library WHERE user_id = $1 AND image_url = $2 AND content_format = $3`,
      [user.id, url, format],
    )
    if (existing) {
      skipped++
      continue
    }
    await query(
      `INSERT INTO pose_library (user_id, image_url, category, nsfw, content_format) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, url, category, nsfw, format],
    )
    imported++
  }

  console.log(`\n${imported} imported, ${skipped} already present.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
