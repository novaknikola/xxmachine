import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { one, query } from '@/lib/db'
import { ensureDriveRootFolder } from '@/lib/drive-archive/ensure-root-folder'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  const cookieStore = await cookies()
  const storedState = cookieStore.get('google_state')?.value
  const characterId = cookieStore.get('google_character_id')?.value
  const accountId = cookieStore.get('google_account_id')?.value
  const purpose = cookieStore.get('google_purpose')?.value
  const archiveUserId = cookieStore.get('google_user_id')?.value

  const clearOAuthCookies = () => {
    cookieStore.delete('google_state')
    cookieStore.delete('google_character_id')
    cookieStore.delete('google_account_id')
    cookieStore.delete('google_purpose')
    cookieStore.delete('google_user_id')
  }

  if (error) {
    clearOAuthCookies()
    const dest = purpose === 'archive' ? '/settings' : accountId ? '/instagram' : '/admin'
    return NextResponse.redirect(`${base}${dest}?google_error=${encodeURIComponent(error)}`)
  }

  const archiveFlow = purpose === 'archive'
  if (
    !code
    || !state
    || state !== storedState
    || (archiveFlow ? !archiveUserId : (!characterId && !accountId))
  ) {
    clearOAuthCookies()
    const dest = archiveFlow ? '/settings' : '/admin'
    return NextResponse.redirect(`${base}${dest}?google_error=invalid_state`)
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
    if (!tokenRes.ok || tokenData.error) {
      throw new Error(tokenData.error_description ?? 'Token exchange failed')
    }

    if (archiveFlow && archiveUserId) {
      const expiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000)
      let rootFolderId: string | null = null
      try {
        rootFolderId = await ensureDriveRootFolder(tokenData.access_token)
      } catch (err) {
        console.error('[google/callback] ensureDriveRootFolder failed:', err)
      }

      await query(
        `UPDATE users
            SET google_access_token = $1,
                google_refresh_token = COALESCE($2, google_refresh_token),
                google_token_expiry = $3,
                drive_root_folder_id = COALESCE($4, drive_root_folder_id),
                drive_auto_archive = true
          WHERE id = $5`,
        [
          tokenData.access_token,
          tokenData.refresh_token ?? null,
          expiry.toISOString(),
          rootFolderId,
          archiveUserId,
        ],
      )
      clearOAuthCookies()
      return NextResponse.redirect(`${base}/settings?tab=drive&google_connected=1`)
    }

    if (accountId) {
      await one(
        `UPDATE instagram_accounts SET google_access_token=$1, google_refresh_token=$2 WHERE id=$3`,
        [tokenData.access_token, tokenData.refresh_token ?? null, accountId],
      )
      clearOAuthCookies()
      return NextResponse.redirect(`${base}/instagram?google_connected=1`)
    }

    await one(
      `UPDATE characters SET google_access_token=$1, google_refresh_token=$2 WHERE id=$3`,
      [tokenData.access_token, tokenData.refresh_token ?? null, characterId],
    )
    clearOAuthCookies()
    return NextResponse.redirect(`${base}/admin?google_connected=1`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    clearOAuthCookies()
    if (archiveFlow) {
      return NextResponse.redirect(`${base}/settings?tab=drive&google_error=${encodeURIComponent(msg)}`)
    }
    const redirectBase = accountId ? `${base}/instagram` : `${base}/admin`
    return NextResponse.redirect(`${redirectBase}?google_error=${encodeURIComponent(msg)}`)
  }
}
