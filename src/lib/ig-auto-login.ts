import type { Page } from 'playwright-core'
// otplib v13 dropped the old `authenticator.generate()` API entirely —
// confirmed live, destructuring `authenticator` returned undefined and
// crashed on the first real 2FA screen reached this session. v13's API is
// generateSync({ secret }).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const otplib = require('otplib')

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

  // Confirmed live, twice: a fixed 3s wait AND a 20s networkidle wait both
  // caught the page still mid-request (screenshot showed the Log in button
  // still spinning past 20s) — this residential proxy is just slow enough
  // that networkidle's "briefly no requests" heuristic never actually
  // fires. Wait directly for the one thing that matters: navigation away
  // from the login path, with a generous timeout for proxy latency. If it
  // times out, the URL check below still runs and reports accurately
  // instead of assuming success.
  await page.waitForURL(u => !u.pathname.includes('/accounts/login'), { timeout: 40000 }).catch(() => {})
  await page.waitForTimeout(1500)

  const url = page.url()

  // Two-factor authentication challenge
  if (url.includes('two_factor') || url.includes('challenge')) {
    if (!creds.totpSecret) throw new Error('2FA required but no TOTP secret provided')
    const code = otplib.generateSync({ secret: creds.totpSecret })

    // Confirmed live via input dump: this screen has exactly one text
    // input (the "Code" field, floating label again — no name/aria-label
    // to match), a hidden submit fallback, and a "trust this device"
    // checkbox (already checked by default). Enter submits reliably, same
    // fix as the login form.
    const codeInput = page.locator('input[type="text"]').first()
    await codeInput.waitFor({ timeout: 15000 })
    await codeInput.click()
    await codeInput.type(code, { delay: 90 + Math.random() * 70 })
    await page.waitForTimeout(400 + Math.random() * 400)
    await page.keyboard.press('Enter')
    await page.waitForURL(u => !u.pathname.includes('/accounts/login') && !u.pathname.includes('/challenge') && !u.pathname.includes('two_factor'), { timeout: 40000 }).catch(() => {})
    await page.waitForTimeout(1500)
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
