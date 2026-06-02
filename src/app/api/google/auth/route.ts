import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI!

export async function GET(req: NextRequest) {
  const characterId = req.nextUrl.searchParams.get('characterId')
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!characterId && !accountId) return NextResponse.json({ error: 'characterId or accountId required' }, { status: 400 })

  if (!CLIENT_ID) return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not set in .env.local — create OAuth credentials at console.cloud.google.com' }, { status: 500 })

  const state = randomBytes(16).toString('hex')
  const cookieStore = await cookies()
  cookieStore.set('google_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600 })
  if (accountId) {
    cookieStore.set('google_account_id', accountId, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600 })
  } else {
    cookieStore.set('google_character_id', characterId!, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600 })
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/drive')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)

  return NextResponse.redirect(url.toString())
}
