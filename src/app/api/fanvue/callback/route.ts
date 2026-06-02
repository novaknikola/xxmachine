import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCode } from '@/lib/fanvue'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDesc = searchParams.get('error_description')

  if (error) {
    return NextResponse.redirect(new URL(`/fans?fanvue_error=${encodeURIComponent(errorDesc ?? error)}`, req.url))
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/fans?fanvue_error=missing_params', req.url))
  }

  const cookieStore = await cookies()
  const storedVerifier = cookieStore.get('fanvue_code_verifier')?.value
  const storedState = cookieStore.get('fanvue_state')?.value

  if (!storedVerifier || !storedState || storedState !== state) {
    return NextResponse.redirect(new URL('/fans?fanvue_error=state_mismatch', req.url))
  }

  try {
    const tokens = await exchangeCode(code, storedVerifier)

    const secure = process.env.NODE_ENV === 'production'
    const maxAge = 60 * 60 * 24 * 30

    cookieStore.set('fanvue_access_token', tokens.access_token, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_refresh_token', tokens.refresh_token, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_expires_at', String(tokens.expires_at), { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_connected', '1', { secure, maxAge })

    cookieStore.delete('fanvue_code_verifier')
    cookieStore.delete('fanvue_state')

    return NextResponse.redirect(new URL('/fans?connected=1', req.url))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.redirect(new URL(`/fans?fanvue_error=${encodeURIComponent(msg)}`, req.url))
  }
}
