// Diagnostic only — logs in (reusing the persistent session from
// test-meta-admin-login.ts if still valid), navigates to the app's Roles
// page, and dumps what's actually there. Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/test-meta-admin-roles-page.ts
import fs from 'fs'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'
import { goToRolesPage, dumpButtons, clickAddPeopleAndDump } from '../src/lib/meta-admin/testers'

const CREDS_PATH = '/root/meta-admin-creds.json'
const APP_ID = '2904588276606941' // "Scheduler" — confirmed by the user as the real app

async function main() {
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
    console.log('✓ Logged in. Navigating to Roles page...')

    await goToRolesPage(page, APP_ID)
    console.log('✓ On Roles page:', page.url())

    await dumpButtons(page)
    await clickAddPeopleAndDump(page)
  } catch (err) {
    console.error('✗ Failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await context.close()
    console.log('Screenshots saved to /root/meta-admin-debug/')
  }
}

main()
