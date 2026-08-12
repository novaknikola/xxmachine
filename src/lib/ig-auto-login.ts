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
  // names (name="email" / name="pass"), and submit is input[type="submit"],
  // not a <button>.
  await page.waitForSelector('input[name="email"]', { timeout: 15000 })
  await page.fill('input[name="email"]', creds.username)
  await page.fill('input[name="pass"]', creds.password)
  await page.click('input[type="submit"], button[type="submit"]')

  // Wait for navigation or 2FA
  await page.waitForTimeout(3000)

  const url = page.url()

  // Two-factor authentication challenge
  if (url.includes('two_factor') || url.includes('challenge')) {
    if (!creds.totpSecret) throw new Error('2FA required but no TOTP secret provided')
    const code = authenticator.generate(creds.totpSecret)
    const input = await page.$('input[name="verificationCode"], input[aria-label*="code"], input[autocomplete="one-time-code"]')
    if (!input) throw new Error('2FA input not found on page')
    await input.fill(code)
    await page.click('button[type="submit"], [data-testid="two-factor-auth-submit-button"]')
    await page.waitForTimeout(3000)
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
    await page.waitForTimeout(3000)
  }
}
