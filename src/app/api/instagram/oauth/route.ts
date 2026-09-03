import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { getInstagramAppCredentials } from '@/lib/instagram/app-credentials'
import { issueOAuthState } from '@/lib/instagram/oauth-state'

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  let accountId = req.nextUrl.searchParams.get('accountId')
  if (accountId) {
    const owned = await one<{ id: string }>(
      `SELECT id FROM instagram_accounts WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)`,
      [accountId, auth.id],
    )
    if (!owned) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    await one(
      `UPDATE instagram_accounts SET user_id = COALESCE(user_id, $2) WHERE id=$1`,
      [accountId, auth.id],
    )
  } else {
    const created = await one<{ id: string }>(
      `INSERT INTO instagram_accounts (name, user_id)
       VALUES ('New Instagram account', $1)
       RETURNING id`,
      [auth.id],
    )
    if (!created) {
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 })
    }
    accountId = created.id
  }

  let appId: string
  try {
    const creds = await getInstagramAppCredentials(auth.id)
    appId = creds.appId
  } catch {
    return NextResponse.json(
      {
        error:
          'Instagram App ID is not configured. Set ig_app_id in Settings, or INSTAGRAM_APP_ID as fallback.',
      },
      { status: 500 },
    )
  }

  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI
  if (!redirectUri) {
    return NextResponse.json(
      { error: 'INSTAGRAM_REDIRECT_URI must be set in .env.local' },
      { status: 500 },
    )
  }

  const state = await issueOAuthState({ accountId, userId: auth.id })

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
    response_type: 'code',
    force_reauth: 'true',
    state,
  })

  return NextResponse.redirect(
    `https://www.instagram.com/oauth/authorize?${params.toString()}`,
  )
}
