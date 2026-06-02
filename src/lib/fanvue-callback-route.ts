import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCode, saveTokens } from '@/lib/fanvue'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL(`/fans?error=${encodeURIComponent(error)}`, req.url))
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/fans?error=missing_params', req.url))
  }

  const cookieStore = await cookies()
  const storedVerifier = cookieStore.get('fanvue_code_verifier')?.value
  const storedState = cookieStore.get('fanvue_state')?.value

  if (!storedVerifier || !storedState || storedState !== state) {
    return NextResponse.redirect(new URL('/fans?error=state_mismatch', req.url))
  }

  try {
    const tokens = await exchangeCode(code, storedVerifier)
    saveTokens(tokens)

    // Clear PKCE cookies
    cookieStore.delete('fanvue_code_verifier')
    cookieStore.delete('fanvue_state')

    // Set connected flag cookie for client
    cookieStore.set('fanvue_connected', '1', { maxAge: 60 * 60 * 24 * 30 })

    return NextResponse.redirect(new URL('/fans?connected=1', req.url))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return NextResponse.redirect(new URL(`/fans?error=${encodeURIComponent(msg)}`, req.url))
  }
}
