// Live test for addInstagramTester — needs a real Instagram username not
// already added as a tester. Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/test-add-instagram-tester.ts <ig-username>
import fs from 'fs'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'
import { addInstagramTester } from '../src/lib/meta-admin/testers'

const CREDS_PATH = '/root/meta-admin-creds.json'
const APP_ID = '2904588276606941' // "Scheduler" — confirmed by the user as the real app

async function main() {
  const igUsername = process.argv[2]
  if (!igUsername) {
    console.error('Usage: tsx scripts/test-add-instagram-tester.ts <ig-username>')
    process.exit(1)
  }
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`Credentials file not found: ${CREDS_PATH}`)
    process.exit(1)
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))

  console.log('Launching browser...')
  const { context, page } = await launchMetaAdminBrowser()

  try {
    console.log('Logging in (reusing saved session if still valid)...')
    await loginToMeta(page, creds)
    console.log(`Adding "${igUsername}" as Instagram Tester...`)
    await addInstagramTester(page, APP_ID, igUsername)
    console.log('✓ Done — check the Roles page / screenshots to confirm it actually landed.')
  } catch (err) {
    console.error('✗ Failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await context.close()
    console.log('Screenshots saved to /root/meta-admin-debug/')
  }
}

main()
