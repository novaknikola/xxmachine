import type { Page } from 'playwright-core'
import { debugScreenshot } from './browser'

export interface MetaAdminCreds {
  login: string
  password: string
  totpSecret?: string | null
}

/**
 * Diagnosed live (2026-08-10): the challenge URL was
 * facebook.com/two_step_verification/authentication/... — no "login.php" or
 * "checkpoint" substring, so a URL-only check missed it. The recaptcha
 * itself is nested two iframes deep (fbsbx.com/captcha/recaptcha/iframe →
 * google.com/recaptcha/enterprise/anchor) and mounted in a way plain DOM
 * queries (page.$$eval('iframe', ...)) don't reach — page.frames() is what
 * actually found both frames in testing, so that's the reliable check here.
 */
async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url()
  if (url.includes('login.php') || url.includes('checkpoint') || url.includes('two_step_verification')) return true
  // After the captcha, Facebook added a further "confirm it's you via your
  // linked Google account" step — a new, distinct block each time so far,
  // which is why this checks for a Google OAuth redirect too, not just the
  // Facebook-side prompt for it.
  if (url.includes('accounts.google.com')) return true
  const emailField = await page.$('input[name="email"], input#email')
  if (emailField) return true
  const hasCaptchaFrame = page.frames().some(f => f.url().includes('recaptcha'))
  if (hasCaptchaFrame) return true
  // The "confirm it's you via Google" prompt reappeared on the next run even
  // after this exact text check was added — a screenshot at that moment
  // proved it was still showing, which means (same lesson as the captcha)
  // it's rendered inside an iframe too. page.getByText() only searches the
  // main frame, so check every frame's own body text instead.
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    if (/confirm it.?s you|verify with google/i.test(text)) return true
  }
  return false
}

/**
 * Facebook's login challenges (captcha, 2FA, "confirm it's you") are too
 * varied to reliably auto-solve, and captcha specifically must not be
 * auto-solved at all. Instead of guessing selectors for whatever appears,
 * this just waits — a human watches the same Xvfb display over VNC and
 * clicks/types through it live, then this notices the block clear.
 */
async function waitForManualResolution(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!(await isBlocked(page))) return true
    await page.waitForTimeout(3000)
  }
  return !(await isBlocked(page))
}

/**
 * Logs into developers.facebook.com via facebook.com/login.php. The email/
 * password fill and login-button click are automated and verified working;
 * anything past that (captcha, 2FA, "confirm it's you") is handed off to a
 * human over VNC rather than guessed at — see waitForManualResolution above.
 */
export async function loginToMeta(page: Page, creds: MetaAdminCreds): Promise<void> {
  // Check first whether the persistent profile is already authenticated —
  // e.g. a human logged in directly via VNC, or a previous run's session is
  // still valid. Skipping straight to login.php unconditionally used to
  // resubmit the login form even when already logged in, which risked
  // tripping a fresh captcha/verification cycle for no reason.
  await page.goto('https://developers.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 })
  if (!(await page.$('a:has-text("Login")'))) {
    await debugScreenshot(page, '00-already-logged-in')
    return
  }

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

    // Facebook appears to A/B-test this page (seen both "Log in to Facebook"
    // and "Log into Facebook" wording across runs) — the button sometimes
    // exposes role=button and sometimes doesn't, so try that first and fall
    // back to a plain text match. The footer's own "Log In" link differs in
    // capitalization from the button's "Log in", so exact text still
    // disambiguates them.
    try {
      await page.getByRole('button', { name: 'Log in', exact: true }).click({ timeout: 8000 })
    } catch {
      await page.getByText('Log in', { exact: true }).first().click({ timeout: 8000 })
    }
    await page.waitForTimeout(4000)
    await debugScreenshot(page, '04-after-submit')
  }

  if (await isBlocked(page)) {
    console.log('[meta-admin-login] Challenge screen reached (captcha/2FA/verification) — connect via VNC and solve it live. Waiting up to 5 minutes...')
    const resolved = await waitForManualResolution(page, 5 * 60 * 1000)
    if (!resolved) {
      await debugScreenshot(page, '05-still-blocked-after-wait')
      throw new Error('Still blocked after 5 minutes — see screenshot 05-still-blocked-after-wait')
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
