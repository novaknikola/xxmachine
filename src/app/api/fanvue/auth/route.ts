import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { generateCodeVerifier, generateCodeChallenge, buildAuthUrl } from '@/lib/fanvue'
import { randomBytes } from 'crypto'
import { requireOwner } from '@/lib/session'

export async function GET(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = randomBytes(16).toString('hex')

  const cookieStore = await cookies()
  cookieStore.set('fanvue_code_verifier', codeVerifier, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600 })
  cookieStore.set('fanvue_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600 })

  const authUrl = buildAuthUrl(codeChallenge, state)
  return NextResponse.redirect(authUrl)
}
