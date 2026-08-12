import type { Page } from 'playwright-core'
// otplib esm — use require for cjs compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticator } = require('otplib')

export interface IgCredentials {
  username: string
  password: string
  totpSecret?: string | null
}

export async function autoLoginInstagram(page: Page, creds: IgCredentials): Promise<void> {
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle', timeout: 30000 })

  // Confirmed via a live input dump (name="username" and placeholder-based
  // guesses both missed): the visible "Mobile number, username or email"
  // text isn't a real placeholder — it's a floating label over a plain
  // name="email" field. Instagram's login form reuses Facebook's own field
  // names (name="email" / name="pass"). The input[type="submit"] the dump
  // found is present but not visible (a hidden native fallback behind
  // whatever renders the actual "Log in" button) — confirmed live, the
  // click just times out waiting for it to become visible. Pressing Enter
  // in the password field submits the form natively regardless of which
  // element is technically the submit control.
  // Correct credentials still got a fake "wrong password" from Instagram
  // (confirmed with the account owner) — the classic tell for anti-bot
  // deception rather than a real credential error. page.fill() sets the
  // value instantly with no keystrokes, which is one of the more obvious
  // automation signals; typing character-by-character with human-scale
  // delays and a couple of "reading the page" pauses is the standard fix.
  await page.waitForSelector('input[name="email"]', { timeout: 15000 })
  await page.waitForTimeout(800 + Math.random() * 1200)

  const emailField = page.locator('input[name="email"]')
  await emailField.click()
  await emailField.type(creds.username, { delay: 90 + Math.random() * 70 })

  await page.waitForTimeout(300 + Math.random() * 500)

  const passField = page.locator('input[name="pass"]')
  await passField.click()
  await passField.type(creds.password, { delay: 90 + Math.random() * 70 })

  await page.waitForTimeout(400 + Math.random() * 600)
  await page.keyboard.press('Enter')

  // Confirmed live: the previous fixed 3s wait caught the page mid-request
  // (screenshot showed the Log in button still spinning) over the added
  // latency of a residential proxy, and the URL check below ran before
  // Instagram's response ever arrived — a false "failed" read, not a real
  // one. Wait for the network to actually settle instead of guessing a
  // fixed delay, with a generous timeout for proxy latency.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(2000)

  const url = page.url()

  // Two-factor authentication challenge
  if (url.includes('two_factor') || url.includes('challenge')) {
    if (!creds.totpSecret) throw new Error('2FA required but no TOTP secret provided')
    const code = authenticator.generate(creds.totpSecret)
    const input = await page.$('input[name="verificationCode"], input[aria-label*="code"], input[autocomplete="one-time-code"]')
    if (!input) throw new Error('2FA input not found on page')
    await input.fill(code)
    await page.click('button[type="submit"], [data-testid="two-factor-auth-submit-button"]')
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2000)
  }

  // Check if logged in (redirected to feed or home)
  const finalUrl = page.url()
  if (finalUrl.includes('/accounts/login') || finalUrl.includes('/challenge')) {
    throw new Error('Login failed — wrong credentials or blocked by Instagram')
  }
}

export async function authorizeMetaOAuth(page: Page, oauthUrl: string): Promise<void> {
  await page.goto(oauthUrl, { waitUntil: 'networkidle', timeout: 30000 })

  await page.waitForTimeout(2000)

  // Click the "Authorize" / "Allow" button on Meta's permission page
  const authorizeBtn = await page.$(
    'button[name="__CONFIRM__"], ' +
    '[data-testid="app-install-allow-button"], ' +
    'button:has-text("Authorize"), ' +
    'button:has-text("Allow"), ' +
    'button:has-text("Continue")'
  )
  if (authorizeBtn) {
    await authorizeBtn.click()
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2000)
  }
}
