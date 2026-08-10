import type { Page } from 'playwright-core'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib')
import { debugScreenshot } from './browser'

export interface MetaAdminCreds {
  login: string
  password: string
  totpSecret?: string | null
}

/**
 * Logs into developers.facebook.com. Selectors here are best-effort from
 * Facebook's long-stable classic login form — this has NOT been verified
 * against a live session yet, so it takes a screenshot after every step and
 * is written to fail loudly with the screenshot path rather than silently
 * clicking the wrong thing. Expect to iterate on selectors after the first
 * real run.
 */
export async function loginToMeta(page: Page, creds: MetaAdminCreds): Promise<void> {
  await page.goto('https://developers.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 })
  await debugScreenshot(page, '01-landing')

  // Already logged in from a previous run (persistent profile) — nothing to do.
  if (!page.url().includes('login')) {
    const loginForm = await page.$('input[name="email"], input#email')
    if (!loginForm) {
      await debugScreenshot(page, '02-already-logged-in')
      return
    }
  }

  const emailInput = await page.waitForSelector(
    'input[name="email"], input#email',
    { timeout: 15000 },
  ).catch(() => null)

  if (!emailInput) {
    // Might have landed on a "log in with Facebook" interstitial first.
    const loginLink = await page.$('a:has-text("Log In"), a[href*="login"]')
    if (loginLink) {
      await loginLink.click()
      await page.waitForTimeout(2000)
    }
  }

  await page.waitForSelector('input[name="email"], input#email', { timeout: 15000 })
  await page.fill('input[name="email"], input#email', creds.login)
  await page.fill('input[name="pass"], input#pass', creds.password)
  await debugScreenshot(page, '03-filled-login')

  await page.click('button[name="login"], button[data-testid="royal_login_button"], button[type="submit"]')
  await page.waitForTimeout(4000)
  await debugScreenshot(page, '04-after-submit')

  const url = page.url()
  if (url.includes('checkpoint') || url.includes('two_step') || url.includes('two_factor')) {
    if (!creds.totpSecret) {
      throw new Error('2FA checkpoint reached but no TOTP secret provided — see screenshot 04-after-submit')
    }
    const code = authenticator.generate(creds.totpSecret)
    const codeInput = await page.waitForSelector(
      'input[name="approvals_code"], input[aria-label*="code" i], input[autocomplete="one-time-code"]',
      { timeout: 15000 },
    ).catch(() => null)
    if (!codeInput) {
      await debugScreenshot(page, '05-no-2fa-input-found')
      throw new Error('Reached a checkpoint but could not find the 2FA code input — see screenshot 05-no-2fa-input-found')
    }
    await codeInput.fill(code)
    await debugScreenshot(page, '06-filled-2fa')
    await page.click(
      'button[id="checkpointSubmitButton"], button:has-text("Continue"), div[aria-label="Continue"]',
    )
    await page.waitForTimeout(4000)
    await debugScreenshot(page, '07-after-2fa-submit')

    // "Save browser" / "trust this device" interstitial — try to dismiss
    // either way so future runs need 2FA less often.
    const saveBrowserBtn = await page.$('button:has-text("Continue"), div[aria-label="Continue"]')
    if (saveBrowserBtn) {
      await saveBrowserBtn.click()
      await page.waitForTimeout(2000)
      await debugScreenshot(page, '08-after-save-browser')
    }
  }

  await page.goto('https://developers.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 })
  await debugScreenshot(page, '09-final-state')

  if (page.url().includes('login') || page.url().includes('checkpoint')) {
    throw new Error(`Login did not complete — still on ${page.url()}. See screenshot 09-final-state`)
  }
}
