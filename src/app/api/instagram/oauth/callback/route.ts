import { NextRequest, NextResponse } from 'next/server'
import { getInstagramAppCredentials } from '@/lib/instagram/app-credentials'
import {
  classifyMetaError,
  isUnsupportedRequest,
} from '@/lib/instagram/oauth-errors'
import { consumeOAuthState, OAuthStateError } from '@/lib/instagram/oauth-state'
import {
  IgUserConflictError,
  IgUserOverwriteError,
  persistOAuthTokens,
} from '@/lib/instagram/tokens'

function redirectError(base: string, code: string) {
  return NextResponse.redirect(`${base}/socials?instagram_error=${encodeURIComponent(code)}`)
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')
  const errorDescription = req.nextUrl.searchParams.get('error_description')

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? req.nextUrl.origin

  if (error) {
    const combined = [error, errorDescription].filter(Boolean).join(': ')
    if (isUnsupportedRequest(combined)) return redirectError(base, 'tester_required')
    return redirectError(base, error)
  }
  if (!code || !state) {
    return redirectError(base, 'missing_code')
  }

  let accountId: string
  let userId: string
  try {
    const consumed = await consumeOAuthState(state)
    accountId = consumed.accountId
    userId = consumed.userId
  } catch (err) {
    if (err instanceof OAuthStateError) return redirectError(base, 'invalid_state')
    console.error('[instagram/oauth/callback] state', err instanceof Error ? err.message : err)
    return redirectError(base, 'invalid_state')
  }

  let appId: string
  let appSecret: string
  try {
    const creds = await getInstagramAppCredentials(userId)
    appId = creds.appId
    appSecret = creds.appSecret
  } catch {
    return redirectError(base, 'server_config')
  }

  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI
  if (!redirectUri) {
    return redirectError(base, 'server_config')
  }

  try {
    // Step A: Exchange code for short-lived token (1 hour)
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    const tokenData = await tokenRes.json()
    // Instagram wraps this in { data: [{ access_token, user_id, permissions }] } for
    // Business Login apps, but returns a flat object for plain Instagram Login apps.
    const tokenPayload = tokenData.data?.[0] ?? tokenData
    if (!tokenRes.ok || !tokenPayload.access_token) {
      const raw = tokenData.error_message ?? tokenData.error?.message ?? 'Token exchange failed'
      console.error('[instagram/oauth/callback] Step A failed (token redacted)')
      if (isUnsupportedRequest(raw)) return redirectError(base, 'tester_required')
      throw new Error(raw)
    }
    const shortLivedToken: string = tokenPayload.access_token
    console.log(
      '[instagram/oauth/callback] Step A success, non-token fields:',
      JSON.stringify({ ...tokenPayload, access_token: '<redacted>', user_id: tokenPayload.user_id ?? null }),
    )

    // Step B: Exchange for long-lived token (60 days). GET per Meta's docs — confirmed
    // this endpoint responds correctly (proper OAuthException) to GET/POST alike when
    // given a garbage token, so the "Unsupported request - method type" error our real
    // token triggers is not a verb issue. It's Development mode: the account must be
    // an Instagram Tester and must have accepted the tester invite.
    const llRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortLivedToken)}`
    )
    const llData = await llRes.json()
    const llPayload = llData.data?.[0] ?? llData
    if (!llRes.ok || !llPayload.access_token) {
      const raw = llData.error?.message ?? 'Long-lived token exchange failed'
      console.error('[instagram/oauth/callback] Step B failed (token redacted)')
      if (isUnsupportedRequest(raw)) return redirectError(base, 'tester_required')
      throw new Error(raw)
    }
    const longLivedToken: string = llPayload.access_token
    const expiresIn: number = llPayload.expires_in ?? 5184000
    const expiresAt = new Date(Date.now() + expiresIn * 1000)

    // Step C: Get user info — must be versioned; unversioned graph.instagram.com/me
    // does not resolve on this product and returns a generic method error.
    const meRes = await fetch(
      `https://graph.instagram.com/v22.0/me?fields=user_id,username&access_token=${encodeURIComponent(longLivedToken)}`
    )
    const meData = await meRes.json()
    const mePayload = meData.data?.[0] ?? meData
    if (!meRes.ok || !mePayload.user_id) {
      const raw = meData.error?.message ?? 'Failed to fetch user info'
      console.error('[instagram/oauth/callback] Step C failed (token redacted)')
      if (isUnsupportedRequest(raw)) return redirectError(base, 'tester_required')
      throw new Error(raw)
    }

    // Step D: Persist — encrypted token + issuing App ID. Overwrite guard + UNIQUE
    // (user_id, ig_user_id) prevent attaching a different IG profile to this row.
    await persistOAuthTokens({
      accountId,
      userId,
      igUserId: String(mePayload.user_id),
      accessToken: longLivedToken,
      expiresAt,
      appId,
      username: mePayload.username ?? null,
    })

    return NextResponse.redirect(`${base}/socials?instagram_connected=1`)
  } catch (err) {
    if (err instanceof IgUserOverwriteError) return redirectError(base, 'account_overwrite')
    if (err instanceof IgUserConflictError) return redirectError(base, 'ig_user_conflict')
    const message = err instanceof Error ? err.message : String(err)
    if (isUnsupportedRequest(message)) return redirectError(base, 'tester_required')
    const classified = classifyMetaError(message)
    console.error('[instagram/oauth/callback]', classified.code)
    return redirectError(base, classified.code === 'tester_required' ? 'tester_required' : classified.code)
  }
}
