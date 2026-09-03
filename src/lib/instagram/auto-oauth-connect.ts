import fs from 'fs'
import path from 'path'
import { one } from '@/lib/db'
import { getCharacterBrowserConfig, launchWithConfig } from '@/lib/browser-launcher'
import { decryptIgSecretOrNull } from '@/lib/instagram/secrets'
import { issueOAuthState } from '@/lib/instagram/oauth-state'
import { getInstagramAppCredentials } from '@/lib/instagram/app-credentials'
import { autoLoginInstagram, acceptInstagramTesterInvite, authorizeMetaOAuth } from '@/lib/ig-auto-login'

const DEBUG_DIR = '/root/ig-oauth-debug'

async function debugScreenshot(page: import('playwright-core').Page, accountId: string, name: string): Promise<void> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  await page.screenshot({ path: path.join(DEBUG_DIR, `${accountId}-${Date.now()}-${name}.png`), fullPage: true }).catch(() => {})
}

function buildOAuthUrl(appId: string, state: string): string {
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI
  if (!redirectUri) throw new Error('INSTAGRAM_REDIRECT_URI not set')

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
    response_type: 'code',
    force_reauth: 'true',
    state,
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
  const acc = await one<{
    ig_username: string | null
    ig_password: string | null
    ig_totp_secret: string | null
    user_id: string | null
  }>(
    `SELECT ig_username, ig_password, ig_totp_secret, user_id FROM instagram_accounts WHERE id=$1`,
    [accountId],
  )
  const password = decryptIgSecretOrNull(acc?.ig_password)
  if (!acc?.ig_username || !password) throw new Error('Account has no ig_username/ig_password saved')
  if (!acc.user_id) throw new Error('Account has no user_id — cannot start OAuth')
  const { appId } = await getInstagramAppCredentials(acc.user_id)
  const state = await issueOAuthState({ accountId, userId: acc.user_id })

  const config = await getCharacterBrowserConfig(accountId)
  const { context, page } = await launchWithConfig(config)

  const creds = { username: acc.ig_username, password, totpSecret: decryptIgSecretOrNull(acc.ig_totp_secret) }

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

    // Being added as an Instagram Tester on the Meta dashboard isn't enough
    // while the app is in Development mode — the account must separately
    // accept the tester invite in its own settings, or the OAuth flow below
    // completes (Allow gets clicked, shows as "Active") but our server's
    // token exchange fails with a generic "Unsupported request" error.
    // Best-effort: no-ops if there's no pending invite.
    await acceptInstagramTesterInvite(page).catch(() => {})
    await debugScreenshot(page, accountId, '01b-after-tester-invite-check')

    const oauthUrl = buildOAuthUrl(appId, state)
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
    // The 03 screenshot has shown a bare {"error":"unauthenticated"} JSON
    // body with no page chrome at all more than once — that shape doesn't
    // match anything oauth/callback/route.ts itself returns (it only ever
    // redirects), so the URL is the only way to tell whether this is our
    // route, a redirect target, or something else entirely intercepting it.
    console.log('[auto-oauth-connect] DEBUG final url:', page.url())

    if (!hasToken) {
      // Distinguish a suspended account from a generic stuck-flow failure —
      // confirmed live that Instagram routes OAuth straight to this URL for
      // suspended accounts instead of any error the loop above recognizes,
      // so it otherwise surfaces as an opaque "ran with no error" failure.
      if (page.url().includes('/accounts/suspended/')) {
        throw new Error('Instagram has suspended this account')
      }
      // Same reasoning as the suspended case — this one lands back on our
      // own /login page carrying the real failure in an instagram_error
      // query param instead of throwing anywhere the loop above would
      // catch it. Confirmed live 2026-08-19: this exact string is the
      // "account was never actually granted the Instagram Tester role"
      // signature (see acceptInstagramTesterInvite) — surfacing it
      // distinctly (not the generic message below) is what lets
      // sync-accounts-from-sheet.ts's isTesterGateError route this into a
      // tester-add retry instead of repeating the same doomed attempt.
      //
      // decodeURIComponent alone does NOT turn "+" back into a space (that's
      // form-encoding, a different convention from %XX escaping) — confirmed
      // live this exact check failed to match "Unsupported+request" against
      // a regex written assuming a real space, even after decoding. Query
      // params here use "+" for spaces, so that has to be normalized first.
      const decodedUrl = decodeURIComponent(page.url().replace(/\+/g, ' '))
      if (/unsupported request/i.test(decodedUrl)) {
        throw new Error('Unsupported request — account was never actually granted the Instagram Tester role')
      }
      throw new Error('OAuth flow ran with no error but no access token was written — check the 02/03 screenshots for the actual final page')
    }

    return { username: acc.ig_username }
  } finally {
    await context.close()
  }
}
