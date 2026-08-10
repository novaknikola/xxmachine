/**
 * Bulk-import pose reference images into pose_library.
 *
 *   npx tsx scripts/import-pose-library.ts <folder> [--category NAME] [--nsfw] [--user EMAIL]
 *
 * Every image file directly inside <folder> becomes one pose_library row.
 * --user defaults to the only account this project has used so far
 * (novakovicbbrs@gmail.com) — pass --user to target a different one.
 */
import { resolve } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i

function parseArgs(argv: string[]) {
  const folder = argv[0]
  let category: string | null = null
  let nsfw = false
  let userEmail = 'novakovicbbrs@gmail.com'
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--category') category = argv[++i] ?? null
    else if (argv[i] === '--nsfw') nsfw = true
    else if (argv[i] === '--user') userEmail = argv[++i] ?? userEmail
  }
  return { folder, category, nsfw, userEmail }
}

async function main() {
  const { folder, category, nsfw, userEmail } = parseArgs(process.argv.slice(2))
  if (!folder) {
    console.error('usage: npx tsx scripts/import-pose-library.ts <folder> [--category NAME] [--nsfw] [--user EMAIL]')
    process.exit(1)
  }

  const { one, query } = await import('../src/lib/db')
  const { uploadBuffer } = await import('../src/lib/supabase-storage')

  const user = await one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [userEmail])
  if (!user) throw new Error(`No user with email ${userEmail}`)

  const files = readdirSync(resolve(folder)).filter(f => IMAGE_EXT.test(f))
  if (!files.length) throw new Error(`No image files directly in ${folder}`)

  console.log(`Importing ${files.length} pose(s) for user ${userEmail} (nsfw=${nsfw}, category=${category ?? 'none'})…`)

  let ok = 0
  for (const file of files) {
    try {
      const buf = readFileSync(resolve(folder, file))
      const ext = file.toLowerCase().endsWith('.png') ? 'png' : file.toLowerCase().endsWith('.webp') ? 'webp' : 'jpg'
      const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      const path = `pose-library/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
      const url = await uploadBuffer(buf, path, contentType)

      await query(
        `INSERT INTO pose_library (user_id, image_url, category, nsfw) VALUES ($1, $2, $3, $4)`,
        [user.id, url, category, nsfw],
      )
      ok++
      console.log(`  ✓ ${file}`)
    } catch (err) {
      console.error(`  ✗ ${file}:`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`\n${ok}/${files.length} imported.`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
