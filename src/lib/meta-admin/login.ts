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
  // developers.facebook.com's own landing page is public — it has no email
  // field and doesn't redirect to /login even when logged out, so its
  // presence/absence can't tell us the login state. Go straight to
  // Facebook's actual login URL instead: if the persistent profile already
  // has a valid session, this redirects to the logged-in home on its own;
  // otherwise the form is right there.
  await page.goto('https://www.facebook.com/login.php', { waitUntil: 'networkidle', timeout: 30000 })
  await debugScreenshot(page, '01-login-page')

  const emailInput = await page.$('input[name="email"], input#email')
  if (!emailInput) {
    await debugScreenshot(page, '02-already-logged-in')
  } else {
    await page.fill('input[name="email"], input#email', creds.login)
    await page.fill('input[name="pass"], input#pass', creds.password)
    await debugScreenshot(page, '03-filled-login')

    // Facebook's login button is a custom-rendered element with no stable
    // name/type attribute — role+accessible-name is far more resilient than
    // guessing CSS here. The page footer also has a plain "Log in" link, so
    // scope to role=button specifically to avoid matching that instead.
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.waitForTimeout(4000)
    await debugScreenshot(page, '04-after-submit')
  }

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

  const postLoginUrl = page.url()
  if (postLoginUrl.includes('login.php') || postLoginUrl.includes('checkpoint')) {
    throw new Error(`Login did not complete — still on ${postLoginUrl}. See the last screenshot.`)
  }

  // developers.facebook.com never redirects to a login URL on its own (it's
  // a public page either way), so verify by checking for the "Login" link
  // it shows in the top-right corner when logged out.
  await page.goto('https://developers.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 })
  await debugScreenshot(page, '09-final-state')

  const loggedOutLink = await page.$('a:has-text("Login")')
  if (loggedOutLink) {
    throw new Error('Reached developers.facebook.com but it still shows a "Login" link — session did not carry over. See screenshot 09-final-state')
  }
}
