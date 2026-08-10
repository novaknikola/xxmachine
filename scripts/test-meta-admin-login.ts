// Standalone login test — NOT wired into the app. Run manually on the VPS:
//   npx tsx scripts/test-meta-admin-login.ts
// Reads credentials from /root/meta-admin-creds.json (outside the repo,
// never committed), a file only the VPS admin creates by hand:
//   {"login": "...", "password": "...", "totpSecret": "..."}
import fs from 'fs'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'

const CREDS_PATH = '/root/meta-admin-creds.json'

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`Credentials file not found: ${CREDS_PATH}`)
    console.error('Create it with: {"login": "...", "password": "...", "totpSecret": "..."}')
    process.exit(1)
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))

  console.log('Launching browser...')
  const { context, page } = await launchMetaAdminBrowser()

  try {
    console.log('Logging in...')
    await loginToMeta(page, creds)
    console.log('✓ Login succeeded. Current URL:', page.url())
  } catch (err) {
    console.error('✗ Login failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await context.close()
    console.log('Screenshots saved to /root/meta-admin-debug/')
  }
}

main()
