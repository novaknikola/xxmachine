import fs from 'fs'
import path from 'path'
import { one } from '@/lib/db'
import { getCharacterBrowserConfig, launchWithConfig } from '@/lib/browser-launcher'
import { autoLoginInstagram, authorizeMetaOAuth } from '@/lib/ig-auto-login'

const DEBUG_DIR = '/root/ig-oauth-debug'

async function debugScreenshot(page: import('playwright-core').Page, accountId: string, name: string): Promise<void> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  await page.screenshot({ path: path.join(DEBUG_DIR, `${accountId}-${Date.now()}-${name}.png`), fullPage: true }).catch(() => {})
}

function buildOAuthUrl(accountId: string): string {
  const appId = process.env.INSTAGRAM_APP_ID
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI
  if (!appId || !redirectUri) throw new Error('INSTAGRAM_APP_ID / INSTAGRAM_REDIRECT_URI not set')

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
    response_type: 'code',
    force_reauth: 'true',
    state: accountId,
  })
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`
}

/**
 * Logs into Instagram as the account (saved credentials) and clicks through
 * the OAuth authorize screen, landing on our own callback URL which does the
 * actual token exchange/DB write (unchanged, same route the manual "Connect
 * API/Graph" button already uses). authorizeMetaOAuth()'s button selectors
 * are pre-existing but were never exercised (confirmed dead code before this
 * session's Xvfb fix) — this takes screenshots at each step so a live test
 * run is diagnosable if they're wrong, same as the meta-admin login work.
 */
export async function connectAccountViaOAuth(accountId: string): Promise<{ username: string }> {
  const acc = await one<{ ig_username: string | null; ig_password: string | null; ig_totp_secret: string | null }>(
    `SELECT ig_username, ig_password, ig_totp_secret FROM instagram_accounts WHERE id=$1`,
    [accountId],
  )
  if (!acc?.ig_username || !acc.ig_password) throw new Error('Account has no ig_username/ig_password saved')

  const config = await getCharacterBrowserConfig(accountId)
  const { context, page } = await launchWithConfig(config)

  const creds = { username: acc.ig_username, password: acc.ig_password, totpSecret: acc.ig_totp_secret }

  try {
    try {
      await autoLoginInstagram(page, creds)
    } catch (err) {
      // autoLoginInstagram takes no screenshots of its own — without this,
      // a failure here leaves zero visual evidence of what Instagram
      // actually showed (confirmed live: the debug dir didn't even exist).
      await debugScreenshot(page, accountId, '00-login-failed')
      // Two straight guesses (name attribute, then placeholder) both missed
      // despite the field being clearly visible — dump the real input
      // structure instead of guessing a third time.
      const inputs = await page.$$eval('input', (els: HTMLInputElement[]) => els.map(e => ({
        type: e.getAttribute('type'), name: e.getAttribute('name'),
        placeholder: e.getAttribute('placeholder'), ariaLabel: e.getAttribute('aria-label'),
        id: e.getAttribute('id'),
      }))).catch(() => [])
      console.log('[auto-oauth-connect] DEBUG inputs:', JSON.stringify(inputs, null, 2))
      throw err
    }
    await debugScreenshot(page, accountId, '01-ig-logged-in')

    const oauthUrl = buildOAuthUrl(accountId)
    await authorizeMetaOAuth(page, oauthUrl, creds)
    await debugScreenshot(page, accountId, '02-after-authorize')

    // Confirmed live: authorizeMetaOAuth landing the browser on our own
    // /api/instagram/oauth/callback?code=...&state=... URL means Instagram
    // really did issue an authorization code — the browser just may still
    // be sitting there while our callback route's own server-side token
    // exchange (a further two external API calls) is still in flight. Poll
    // the DB instead of a fixed wait so this doesn't check before that
    // finishes.
    let hasToken = false
    const verifyDeadline = Date.now() + 20000
    while (Date.now() < verifyDeadline) {
      const verify = await one<{ has_token: boolean }>(
        `SELECT (ig_access_token IS NOT NULL) AS has_token FROM instagram_accounts WHERE id=$1`,
        [accountId],
      )
      if (verify?.has_token) { hasToken = true; break }
      await page.waitForTimeout(1500)
    }
    await debugScreenshot(page, accountId, '03-final-state')

    if (!hasToken) {
      throw new Error('OAuth flow ran with no error but no access token was written — check the 02/03 screenshots for the actual final page')
    }

    return { username: acc.ig_username }
  } finally {
    await context.close()
  }
}
