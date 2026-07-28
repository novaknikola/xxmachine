import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'
import { getSessionUser } from '@/lib/session'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!

export async function GET(req: NextRequest) {
  const characterId = req.nextUrl.searchParams.get('characterId')
  const accountId = req.nextUrl.searchParams.get('accountId')
  const purpose = req.nextUrl.searchParams.get('purpose')

  if (!CLIENT_ID) {
    return NextResponse.json(
      { error: 'GOOGLE_CLIENT_ID not set in .env.local — create OAuth credentials at console.cloud.google.com' },
      { status: 500 },
    )
  }

  const cookieStore = await cookies()
  const state = randomBytes(16).toString('hex')
  const secure = process.env.NODE_ENV === 'production'
  cookieStore.set('google_state', state, { httpOnly: true, secure, maxAge: 600 })

  let scope = 'https://www.googleapis.com/auth/drive'

  if (purpose === 'archive') {
    const user = await getSessionUser(req)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    cookieStore.set('google_purpose', 'archive', { httpOnly: true, secure, maxAge: 600 })
    cookieStore.set('google_user_id', user.id, { httpOnly: true, secure, maxAge: 600 })
    // Only files created by this app — safer for per-user archive.
    scope = 'https://www.googleapis.com/auth/drive.file'
  } else if (accountId) {
    cookieStore.set('google_account_id', accountId, { httpOnly: true, secure, maxAge: 600 })
  } else if (characterId) {
    cookieStore.set('google_character_id', characterId, { httpOnly: true, secure, maxAge: 600 })
  } else {
    return NextResponse.json({ error: 'characterId, accountId, or purpose=archive required' }, { status: 400 })
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scope)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)

  return NextResponse.redirect(url.toString())
}
