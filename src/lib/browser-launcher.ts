import path from 'path'
import fs from 'fs'
import { one } from '@/lib/db'
import { generateFingerprint, type BrowserFingerprint } from '@/lib/fingerprint'

export interface AccountBrowserConfig {
  accountId: string
  proxyUrl?: string | null
  fingerprint: BrowserFingerprint
}

export async function getCharacterBrowserConfig(accountId: string): Promise<AccountBrowserConfig> {
  const acc = await one<{
    id: string
    proxy_url: string | null
    browser_fingerprint: BrowserFingerprint | null
  }>(
    `SELECT id, proxy_url, browser_fingerprint FROM instagram_accounts WHERE id=$1`,
    [accountId]
  )
  if (!acc) throw new Error(`Account not found: ${accountId}`)

  const fingerprint = acc.browser_fingerprint ?? generateFingerprint(accountId)

  if (!acc.browser_fingerprint) {
    await one(
      `UPDATE instagram_accounts SET browser_fingerprint=$1 WHERE id=$2`,
      [JSON.stringify(fingerprint), accountId]
    )
  }

  return { accountId, proxyUrl: acc.proxy_url, fingerprint }
}

export async function launchWithConfig(config: AccountBrowserConfig) {
  const { accountId, proxyUrl, fingerprint } = config

  // Use playwright-core directly — playwright-extra causes "Invalid URL" inside Next.js server process
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright-core')

  const userDataDir = path.join(process.cwd(), 'chrome-profiles', accountId).replace(/\\/g, '/')
  fs.mkdirSync(userDataDir, { recursive: true })

  const viewportW = Math.max(fingerprint.screenWidth, 1280)
  const viewportH = Math.max(fingerprint.screenHeight, 900)

  const contextOptions: Record<string, unknown> = {
    headless: false,
    userAgent: fingerprint.userAgent,
    locale: 'en-US',
    timezoneId: fingerprint.timezone,
    viewport: { width: viewportW, height: viewportH },
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${viewportW},${viewportH}`,
    ],
  }

  if (proxyUrl) {
    contextOptions.proxy = { server: proxyUrl }
  }

  const context = await chromium.launchPersistentContext(userDataDir, contextOptions)

  const page = context.pages()[0] ?? await context.newPage()
  await page.addInitScript((fp: BrowserFingerprint) => {
    Object.defineProperty(navigator, 'platform', { get: () => fp.platform })
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 + (fp.screenWidth > 1500 ? 4 : 0) })
    const getParam = WebGLRenderingContext.prototype.getParameter
    // @ts-ignore
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Google Inc. (NVIDIA)'
      if (param === 37446) return fp.webglRenderer
      return getParam.call(this, param)
    }
  }, fingerprint)

  return { context, page }
}
