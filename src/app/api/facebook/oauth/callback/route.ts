import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

const GRAPH_API = 'https://graph.facebook.com/v21.0'

/**
 * Completes Facebook Login for Business: code -> short-lived user token ->
 * long-lived user token -> list every Page the user administers -> persist
 * each one. A Page access_token minted from a long-lived user token is
 * itself long-lived/never-expiring (same property the manually-generated
 * "Diana Daily" token already relies on — see FACEBOOK_PAGE_ACCESS_TOKEN's
 * comment in .env.local), so there's no refresh flow to build here, unlike
 * Instagram's 60-day token that needs periodic renewal.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const error = req.nextUrl.searchParams.get('error')
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? req.nextUrl.origin

  if (error) {
    return NextResponse.redirect(`${base}/socials?platform=facebook&facebook_error=${encodeURIComponent(error)}`)
  }
  if (!code) {
    return NextResponse.redirect(`${base}/socials?platform=facebook&facebook_error=missing_code`)
  }

  const appId = process.env.FACEBOOK_APP_ID
  const appSecret = process.env.FACEBOOK_APP_SECRET
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI
  if (!appId || !appSecret || !redirectUri) {
    return NextResponse.redirect(`${base}/socials?platform=facebook&facebook_error=server_config`)
  }

  try {
    // Step A: code -> short-lived user token
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`,
    )
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[facebook/oauth/callback] Step A raw response:', JSON.stringify(tokenData))
      throw new Error(tokenData.error?.message ?? 'Token exchange failed')
    }
    const shortLivedToken: string = tokenData.access_token

    // Step B: short-lived -> long-lived user token (~60 days)
    const llRes = await fetch(
      `${GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`,
    )
    const llData = await llRes.json()
    if (!llRes.ok || !llData.access_token) {
      console.error('[facebook/oauth/callback] Step B raw response:', JSON.stringify(llData))
      throw new Error(llData.error?.message ?? 'Long-lived token exchange failed')
    }
    const longLivedUserToken: string = llData.access_token

    // Step C: every Page this user administers, each with its own
    // (long-lived) Page access token.
    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(longLivedUserToken)}`,
    )
    const pagesData = await pagesRes.json()
    if (!pagesRes.ok || !Array.isArray(pagesData.data)) {
      console.error('[facebook/oauth/callback] Step C raw response:', JSON.stringify(pagesData))
      throw new Error(pagesData.error?.message ?? 'Failed to list Pages')
    }
    if (!pagesData.data.length) {
      return NextResponse.redirect(
        `${base}/socials?platform=facebook&facebook_error=${encodeURIComponent('No Pages found — you must be an admin of at least one Facebook Page')}`,
      )
    }

    // Step D: persist every returned Page — upsert by page_id so
    // reconnecting refreshes the token without duplicating the row or
    // touching an already-set Drive folder.
    let connected = 0
    for (const page of pagesData.data as Array<{ id: string; name: string; access_token: string }>) {
      await one(
        `INSERT INTO facebook_pages (name, page_id, access_token)
         VALUES ($1,$2,$3)
         ON CONFLICT (page_id) DO UPDATE SET access_token = excluded.access_token, name = excluded.name
         RETURNING id`,
        [page.name, page.id, page.access_token],
      )
      connected++
    }

    return NextResponse.redirect(`${base}/socials?platform=facebook&facebook_connected=${connected}`)
  } catch (err) {
    console.error('[facebook/oauth/callback]', err)
    return NextResponse.redirect(`${base}/socials?platform=facebook&facebook_error=${encodeURIComponent(String(err))}`)
  }
}
