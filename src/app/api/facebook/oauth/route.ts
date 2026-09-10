import { NextResponse } from 'next/server'
import crypto from 'crypto'

/**
 * Kicks off Facebook Login for Business — distinct from Instagram's own
 * dedicated instagram.com OAuth product next door, and from the classic
 * scope-based Facebook Login: this newer product needs a pre-created Login
 * Configuration (App Dashboard → Facebook Login for Business →
 * Configurations, User access token type — a System-user config would
 * instead require a verified Business Portfolio with assets assigned to
 * it, which this app doesn't have set up) whose permissions/asset-type are
 * referenced by config_id — a bare `scope` param 404s with "Feature
 * unavailable" for this product, confirmed live 2026-09-09. The callback
 * then lists every Page the authorizing user manages and connects all of
 * them (see callback/route.ts), rather than taking an accountId the way
 * Instagram's flow does — there's no existing row to attach to yet, the
 * whole point is discovering pages from scratch.
 */
export async function GET() {
  const appId = process.env.FACEBOOK_APP_ID
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI
  const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID
  if (!appId || !redirectUri || !configId) {
    return NextResponse.json(
      { error: 'FACEBOOK_APP_ID, FACEBOOK_REDIRECT_URI and FACEBOOK_LOGIN_CONFIG_ID must be set in .env.local' },
      { status: 500 },
    )
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    config_id: configId,
    response_type: 'code',
    state: crypto.randomUUID(),
  })

  return NextResponse.redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`)
}
