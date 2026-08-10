// Opens the persistent Meta admin browser profile and just leaves it open —
// no automated form-filling at all. Log in manually via VNC (facebook.com,
// type email/password, solve whatever challenges appear yourself), then
// Ctrl+C this script once. The session cookies land in the same persistent
// profile that test-meta-admin-login.ts and test-meta-admin-roles-page.ts
// reuse, so later runs skip straight past login.
//   DISPLAY=:99 npx tsx scripts/open-meta-admin-browser.ts
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'

async function main() {
  console.log('Launching browser — log in manually via VNC now.')
  const { context, page } = await launchMetaAdminBrowser()
  await page.goto('https://www.facebook.com/login.php', { waitUntil: 'networkidle', timeout: 30000 })
  console.log('Browser is open and will stay open. Press Ctrl+C here when done logging in.')

  // Keep the process (and the browser) alive until manually stopped.
  await new Promise(() => {})

  await context.close()
}

main()
