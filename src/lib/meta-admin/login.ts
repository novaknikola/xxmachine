import type { Page } from 'playwright-core'
import { debugScreenshot } from './browser'

export interface MetaAdminCreds {
  login: string
  password: string
  totpSecret?: string | null
}

/**
 * Facebook's login challenges (captcha, 2FA, "confirm it's you") are too
 * varied to reliably auto-solve, and captcha specifically must not be
 * auto-solved at all. Instead of guessing selectors for whatever appears,
 * this just waits — a human watches the same Xvfb display over VNC and
 * clicks/types through it live, then this notices the URL moved on.
 */
async function waitForManualResolution(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(3000)
    const url = page.url()
    if (!url.includes('login.php') && !url.includes('checkpoint')) return true
  }
  return false
}

/**
 * Logs into developers.facebook.com via facebook.com/login.php. The email/
 * password fill and login-button click are automated and verified working;
 * anything past that (captcha, 2FA, "confirm it's you") is handed off to a
 * human over VNC rather than guessed at — see waitForManualResolution above.
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
  if (url.includes('login.php') || url.includes('checkpoint')) {
    console.log('[meta-admin-login] Challenge screen reached (captcha/2FA/verification) — connect via VNC and solve it live. Waiting up to 5 minutes...')
    const resolved = await waitForManualResolution(page, 5 * 60 * 1000)
    if (!resolved) {
      await debugScreenshot(page, '05-still-blocked-after-wait')
      throw new Error('Still on a login/checkpoint page after 5 minutes — see screenshot 05-still-blocked-after-wait')
    }
    await debugScreenshot(page, '06-after-manual-resolution')
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
