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

// Confirmed live: the main site's login page (instagram.com/accounts/login/)
// uses name="email"/name="pass" (Facebook's field names, post-unification),
// but the OAuth authorize flow's own login
// (accounts/login/?force_authentication&...&next=/oauth/authorize/third_party/)
// is the older classic Instagram form with name="username"/name="password"
// instead — different pages, different field names, same visual layout.
const IDENTIFIER_SELECTOR = 'input[name="email"], input[name="username"]'
const PASSWORD_SELECTOR = 'input[name="pass"], input[name="password"]'

// Confirmed live via a clickable-elements dump: "Not now" on the onetap
// screen is a <div role="button">, not a real <button> — every variant is
// checked as both a real button and a role="button" element.
const DISMISS_SELECTOR =
  'button:has-text("Not now"), [role="button"]:has-text("Not now"), ' +
  'button:has-text("Not Now"), [role="button"]:has-text("Not Now"), ' +
  'button:has-text("Continue"), [role="button"]:has-text("Continue"), ' +
  'button:has-text("Save info"), [role="button"]:has-text("Save info")'

const AUTHORIZE_SELECTOR =
  'button[name="__CONFIRM__"], [data-testid="app-install-allow-button"], ' +
  'button:has-text("Authorize"), [role="button"]:has-text("Authorize"), ' +
  'button:has-text("Allow"), [role="button"]:has-text("Allow")'

const WIZARD_NEXT_SELECTOR = 'button:has-text("Next"):not([disabled])'
const WIZARD_DONE_SELECTOR = 'button:has-text("Done"):not([disabled])'
const WIZARD_CONTINUE_SELECTOR = 'button:has-text("Continue"):not([disabled]), [role="button"]:has-text("Continue")'

/**
 * Instagram's Business Login OAuth flow refuses the requested scopes for a
 * personal account and instead routes through its own account-type
 * conversion wizard first — confirmed live end-to-end (2026-08-13):
 * "Change to professional account?" -> Change -> pick Creator (radio
 * value="media_creator", not Business) -> Next -> a benefits info screen ->
 * Next -> category picker (radio list, "Done" disabled until one is picked)
 * -> Done -> a public-account privacy warning modal ("your profile and
 * content will be public") -> Continue -> "account is ready" screen -> Done
 * -> lands back on the normal OAuth consent/Allow screen, which the loop
 * above already handles. No Facebook Page linking anywhere in this path.
 * Always picks Creator and a neutral "Personal blog" category (id 2700,
 * confirmed present in the "Suggested" list) — a generic default, not a
 * claim about what the account actually is. Also unchecks "Show category on
 * profile" (checked by default) since there's no reason to publicize it for
 * these accounts.
 */
async function handleProfessionalAccountConversion(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '')

    if (bodyText.includes('Change to professional account')) {
      const btn = await page.$('button:has-text("Change"), [role="button"]:has-text("Change")')
      if (btn) { await btn.click(); await page.waitForTimeout(2000); return true }
    }

    if (bodyText.includes('Which best describes you')) {
      const radio = await page.$('input[type="radio"][value="media_creator"]')
      if (radio) { await radio.click(); await page.waitForTimeout(500) }
      const next = await page.$(WIZARD_NEXT_SELECTOR)
      if (next) { await next.click(); await page.waitForTimeout(2000); return true }
    }

    if (bodyText.includes('Flexible profile controls')) {
      const next = await page.$(WIZARD_NEXT_SELECTOR)
      if (next) { await next.click(); await page.waitForTimeout(2000); return true }
    }

    if (bodyText.includes('Select a category')) {
      const alreadyChecked = await page.$('input[type="radio"]:checked')
      if (!alreadyChecked) {
        const preferred = await page.$('input[type="radio"][value="2700"]') // "Personal blog"
        const radio = preferred || await page.$('input[type="radio"][value]')
        if (radio) { await radio.click(); await page.waitForTimeout(500) }
      }
      const showOnProfile = await page.$('input[type="checkbox"]:checked')
      if (showOnProfile) await showOnProfile.click().catch(() => {})
      const done = await page.$(WIZARD_DONE_SELECTOR)
      if (done) { await done.click(); await page.waitForTimeout(1500); return true }
    }

    if (bodyText.includes('will be public')) {
      const cont = await page.$(WIZARD_CONTINUE_SELECTOR)
      if (cont) { await cont.click(); await page.waitForTimeout(2500); return true }
    }

    if (bodyText.includes('account is ready')) {
      const done = await page.$(WIZARD_DONE_SELECTOR)
      if (done) { await done.click(); await page.waitForTimeout(2000); return true }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Execution context was destroyed')) return false
    throw err
  }
  return false
}

/**
 * Fills and submits the currently-visible email/pass (or username/password)
 * form, including the 2FA follow-up if one appears. Assumes the identifier
 * field is already confirmed present — callers check that first.
 */
async function fillLoginForm(page: Page, creds: IgCredentials): Promise<void> {
  // Correct credentials still got a fake "wrong password" from Instagram
  // (confirmed with the account owner) — the classic tell for anti-bot
  // deception rather than a real credential error. page.fill() sets the
  // value instantly with no keystrokes, which is one of the more obvious
  // automation signals; typing character-by-character with human-scale
  // delays and a couple of "reading the page" pauses is the standard fix.
  await page.waitForTimeout(800 + Math.random() * 1200)

  const emailField = page.locator(IDENTIFIER_SELECTOR)
  await emailField.click()
  await emailField.type(creds.username, { delay: 90 + Math.random() * 70 })

  await page.waitForTimeout(300 + Math.random() * 500)

  const passField = page.locator(PASSWORD_SELECTOR)
  await passField.click()
  await passField.type(creds.password, { delay: 90 + Math.random() * 70 })

  await page.waitForTimeout(400 + Math.random() * 600)
  await page.keyboard.press('Enter')

  // Confirmed live, twice: a fixed 3s wait AND a 20s networkidle wait both
  // caught the page still mid-request (screenshot showed the Log in button
  // still spinning past 20s) — this residential proxy is just slow enough
  // that networkidle's "briefly no requests" heuristic never actually
  // fires. Wait directly for the one thing that matters: navigation away
  // from the login path, with a generous timeout for proxy latency.
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

export async function autoLoginInstagram(page: Page, creds: IgCredentials): Promise<void> {
  // networkidle is unreliable on this residential proxy (same finding as
  // fillLoginForm's post-submit wait below) — some proxy exit IPs just never
  // go quiet within the timeout even though the page itself loaded fine.
  // domcontentloaded + the poll below for the actual field is the fix.
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 })

  // Poll instead of a single snapshot check — confirmed live that a fixed
  // short wait races the page's own render (a screenshot taken seconds
  // after an instant check still showed the form rendering in).
  let identifierField = await page.$(IDENTIFIER_SELECTOR)
  const pollStart = Date.now()
  while (!identifierField && Date.now() - pollStart < 8000) {
    await page.waitForTimeout(500)
    identifierField = await page.$(IDENTIFIER_SELECTOR)
  }
  if (identifierField) {
    await fillLoginForm(page, creds)
  }
  // No identifier field at all here means the persistent profile is
  // already logged in — nothing to do on the main site's login page.
}

/**
 * Being added as an Instagram Tester on the Meta app dashboard (App roles ->
 * Roles -> Add People, automated separately in testers.ts) is only half the
 * gate — while the app is in Development mode, the account itself must also
 * separately accept the tester invite inside its own Instagram settings.
 * Confirmed live (2026-08-13): skipping this step lets the OAuth authorize
 * flow complete (the account shows up "Active" under Apps and websites,
 * having clicked Allow) but our server's code->token exchange then fails
 * with a generic "Unsupported request - method type: get" — the same
 * account-specific IGApiException documented from an earlier session,
 * caused by the invite sitting unaccepted under Settings -> Apps and
 * websites -> **Tester Invites** (a separate tab from Active/Expired/
 * Removed). Best-effort: does nothing if there's no pending invite (already
 * accepted, or app not in Development mode for this account) rather than
 * treating that as an error.
 */
export async function acceptInstagramTesterInvite(page: Page): Promise<void> {
  await page.goto('https://www.instagram.com/accounts/manage_access/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('text="Apps and websites"', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1000)

  const testerTab = await page.$('text=/Tester Invites/i')
  if (!testerTab) return
  await testerTab.click()
  await page.waitForTimeout(1500)

  const acceptBtn = await page.$('button:has-text("Accept"), [role="button"]:has-text("Accept")')
  if (!acceptBtn) return // no pending invite
  await acceptBtn.click()
  await page.waitForTimeout(2000)
}

/**
 * Instagram's OAuth authorize flow chains through several screens via
 * client-side redirects (its own separate login form, a "remembered
 * account" Continue screen, the /accounts/onetap/ "save login info"
 * interstitial, then finally the Authorize screen) — and confirmed live,
 * more than once, that a fixed check-one-thing-then-move-on sequence keeps
 * missing steps that render in *after* the check already ran (e.g. a
 * snapshot mid-poll showed plain instagram.com/, and moments later the page
 * had gone on to /accounts/onetap/ on its own). Polling in a loop and
 * handling whichever recognizable screen is currently up — rather than
 * assuming a fixed order — is what actually keeps up with that chain.
 */
export async function authorizeMetaOAuth(page: Page, oauthUrl: string, creds: IgCredentials): Promise<void> {
  // Same networkidle-unreliable-on-this-proxy issue as autoLoginInstagram —
  // the loop below already polls for whatever screen actually renders.
  await page.goto(oauthUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // 90s, not 60s: the professional-account conversion sub-flow (when it
  // triggers) is itself 6 extra screens, each with its own wait — the
  // original 60s budget predates that path and is tight once it's added in.
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    // page.$() throws "Execution context was destroyed" if a client-side
    // redirect happens to fire mid-check — confirmed live, twice, crashing
    // the whole flow instead of just meaning "nothing to find this instant."
    // Treat that one error as an empty result and let the loop retry.
    const safe$ = async (selector: string) => {
      try {
        return await page.$(selector)
      } catch (err) {
        if (err instanceof Error && err.message.includes('Execution context was destroyed')) return null
        throw err
      }
    }

    const authorizeBtn = await safe$(AUTHORIZE_SELECTOR)
    if (authorizeBtn) {
      await authorizeBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(2000)
      return
    }

    // Root cause found live (2026-08-12) after several silent "no error, no
    // token" runs: Instagram routes the final redirect to our callback
    // through its own l.instagram.com "leaving Instagram" link-shim page —
    // an outbound-link interstitial this loop never recognized, so it just
    // sat there polling for the rest of its budget and returned having done
    // nothing. Confirmed by a real manual connect landing on exactly this
    // URL shape mid-flow. The actual destination is already sitting in the
    // shim's own `u` query param — going straight there sidesteps needing to
    // find/click whatever confirmation UI that page shows at all.
    const currentUrl = page.url()
    if (currentUrl.includes('l.instagram.com')) {
      const dest = new URL(currentUrl).searchParams.get('u')
      if (dest) {
        await page.goto(decodeURIComponent(dest), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        await page.waitForTimeout(1500)
        continue
      }
    }

    const identifierField = await safe$(IDENTIFIER_SELECTOR)
    if (identifierField) {
      await fillLoginForm(page, creds)
      continue
    }

    if (await handleProfessionalAccountConversion(page)) continue

    const dismissBtn = await safe$(DISMISS_SELECTOR)
    if (dismissBtn) {
      await dismissBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(1500)
      continue
    }

    // Nothing recognized right now — likely mid client-side redirect.
    // Wait and recheck rather than giving up on the first empty snapshot.
    await page.waitForTimeout(1500)
  }
}
