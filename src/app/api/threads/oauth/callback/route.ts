import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const accountId = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  if (error) {
    return NextResponse.redirect(`${base}/socials?platform=threads&threads_error=${encodeURIComponent(error)}`)
  }
  if (!code || !accountId) {
    return NextResponse.redirect(`${base}/socials?platform=threads&threads_error=missing_code`)
  }

  const appId = process.env.THREADS_APP_ID
  const appSecret = process.env.THREADS_APP_SECRET
  const redirectUri = process.env.THREADS_REDIRECT_URI
  if (!appId || !appSecret || !redirectUri) {
    return NextResponse.redirect(`${base}/socials?platform=threads&threads_error=server_config`)
  }

  try {
    // Step A: Exchange code for short-lived token
    const tokenRes = await fetch('https://graph.threads.net/oauth/access_token', {
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
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_message ?? tokenData.error ?? 'Token exchange failed')
    }
    const shortLivedToken: string = tokenData.access_token

    // Step B: Exchange for long-lived token (valid 60 days)
    const llRes = await fetch(
      `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${appSecret}&access_token=${shortLivedToken}`
    )
    const llData = await llRes.json()
    if (!llRes.ok || !llData.access_token) {
      throw new Error(llData.error?.message ?? 'Long-lived token exchange failed')
    }
    const longLivedToken: string = llData.access_token
    const expiresIn: number = llData.expires_in ?? 5184000 // 60 days default
    const expiresAt = new Date(Date.now() + expiresIn * 1000)

    // Step C: Get user info
    const meRes = await fetch(
      `https://graph.threads.net/me?fields=id,username&access_token=${longLivedToken}`
    )
    const meData = await meRes.json()
    if (!meRes.ok) {
      throw new Error(meData.error?.message ?? 'Failed to fetch user info')
    }

    // Step D: Persist
    await one(
      `UPDATE threads_accounts
       SET access_token=$1, threads_user_id=$2, threads_username=$3, token_expires_at=$4
       WHERE id=$5`,
      [longLivedToken, meData.id, meData.username ?? null, expiresAt.toISOString(), accountId]
    )

    return NextResponse.redirect(`${base}/socials?platform=threads&threads_connected=1`)
  } catch (err) {
    console.error('[threads/oauth/callback]', err)
    return NextResponse.redirect(
      `${base}/socials?platform=threads&threads_error=${encodeURIComponent(String(err))}`
    )
  }
}
