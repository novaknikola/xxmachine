// Adds multiple Instagram usernames as testers in one browser session (one
// login, loop through Add People per username) instead of restarting the
// browser per account. Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/bulk-add-instagram-testers.ts user1 user2 user3
import fs from 'fs'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'
import { addInstagramTester } from '../src/lib/meta-admin/testers'

const CREDS_PATH = '/root/meta-admin-creds.json'
const APP_ID = '2904588276606941'

async function main() {
  const usernames = process.argv.slice(2)
  if (!usernames.length) {
    console.error('Usage: tsx scripts/bulk-add-instagram-testers.ts user1 user2 ...')
    process.exit(1)
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))

  console.log('Launching browser...')
  const { context, page } = await launchMetaAdminBrowser()

  const results: Record<string, 'ok' | string> = {}

  try {
    console.log('Logging in (reusing saved session if still valid)...')
    await loginToMeta(page, creds)

    for (const username of usernames) {
      try {
        console.log(`Adding "${username}"...`)
        await addInstagramTester(page, APP_ID, username)
        results[username] = 'ok'
        console.log(`  ✓ ${username}`)
      } catch (err) {
        results[username] = err instanceof Error ? err.message : String(err)
        console.log(`  ✗ ${username}: ${results[username]}`)
      }
      await page.waitForTimeout(2000)
    }
  } finally {
    await context.close()
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(results, null, 2))
  const failed = Object.values(results).filter(v => v !== 'ok').length
  if (failed > 0) process.exitCode = 1
}

main()
