import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) {
    return NextResponse.json({ error: 'accountId required' }, { status: 400 })
  }

  const appId = process.env.THREADS_APP_ID
  const redirectUri = process.env.THREADS_REDIRECT_URI
  if (!appId || !redirectUri) {
    return NextResponse.json(
      { error: 'THREADS_APP_ID and THREADS_REDIRECT_URI must be set in .env.local' },
      { status: 500 }
    )
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: 'threads_basic,threads_content_publish',
    response_type: 'code',
    state: accountId,
  })

  return NextResponse.redirect(
    `https://threads.net/oauth/authorize?${params.toString()}`
  )
}
