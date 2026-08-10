import path from 'path'
import fs from 'fs'

/**
 * Single stable Chrome profile for the admin's own Meta login — unlike
 * browser-launcher.ts (one fingerprinted profile per Instagram account),
 * there's only ever one Meta admin identity, so one persistent profile is
 * enough and lets the session (cookies, "remember this device" for 2FA)
 * survive between runs.
 */
export async function launchMetaAdminBrowser() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright-core')

  const userDataDir = path.join(process.cwd(), 'chrome-profiles', 'meta-admin').replace(/\\/g, '/')
  fs.mkdirSync(userDataDir, { recursive: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const page = context.pages()[0] ?? await context.newPage()
  return { context, page }
}

/**
 * Saves a screenshot to a debug folder outside the web root so a human (or
 * the next Claude session) can inspect exactly what the automation saw at
 * each step — essential for fixing selectors against a live site nobody
 * here can watch render in real time.
 */
export async function debugScreenshot(page: import('playwright-core').Page, name: string): Promise<string> {
  const dir = '/root/meta-admin-debug'
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}
