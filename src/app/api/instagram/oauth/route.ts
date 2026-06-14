import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) {
    return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  }

  const appId = process.env.INSTAGRAM_APP_ID
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI
  if (!appId || !redirectUri) {
    return NextResponse.json(
      { error: 'INSTAGRAM_APP_ID and INSTAGRAM_REDIRECT_URI must be set in .env.local' },
      { status: 500 }
    )
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish,instagram_business_manage_insights',
    response_type: 'code',
    force_reauth: 'true',
    state: accountId,
  })

  return NextResponse.redirect(
  `https://www.instagram.com/oauth/authorize?${params.toString()}`
)
}
