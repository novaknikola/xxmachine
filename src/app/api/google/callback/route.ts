import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { one } from '@/lib/db'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  if (error) return NextResponse.redirect(`${base}/admin?google_error=${encodeURIComponent(error)}`)

  const cookieStore = await cookies()
  const storedState = cookieStore.get('google_state')?.value
  const characterId = cookieStore.get('google_character_id')?.value
  const accountId = cookieStore.get('google_account_id')?.value

  if (!code || !state || state !== storedState || (!characterId && !accountId)) {
    return NextResponse.redirect(`${base}/admin?google_error=invalid_state`)
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok || tokenData.error) throw new Error(tokenData.error_description ?? 'Token exchange failed')

    if (accountId) {
      await one(
        `UPDATE instagram_accounts SET google_access_token=$1, google_refresh_token=$2 WHERE id=$3`,
        [tokenData.access_token, tokenData.refresh_token ?? null, accountId]
      )
      cookieStore.delete('google_state')
      cookieStore.delete('google_account_id')
      return NextResponse.redirect(`${base}/instagram?google_connected=1`)
    } else {
      await one(
        `UPDATE characters SET google_access_token=$1, google_refresh_token=$2 WHERE id=$3`,
        [tokenData.access_token, tokenData.refresh_token ?? null, characterId]
      )
      cookieStore.delete('google_state')
      cookieStore.delete('google_character_id')
      return NextResponse.redirect(`${base}/admin?google_connected=1`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    const redirectBase = accountId ? `${base}/instagram` : `${base}/admin`
    return NextResponse.redirect(`${redirectBase}?google_error=${encodeURIComponent(msg)}`)
  }
}
