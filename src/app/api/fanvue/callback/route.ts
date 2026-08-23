import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { appendFileSync } from 'node:fs'
import { exchangeCode } from '@/lib/fanvue'
import { getSessionUser } from '@/lib/session'
import { saveFanvueConnectionToDb, syncFanvueCreatorsToDb, getStoredRefreshToken } from '@/lib/fanvue-db-token'

// TEMP — self-contained debug trail for the DB-persist step, since the running dev server's
// stdout isn't reachable from here. Remove once the DB-write path is confirmed working.
function debugLog(line: string) {
  try {
    appendFileSync('debug-fanvue-callback.log', `${new Date().toISOString()} ${line}\n`)
  } catch { /* best-effort */ }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user?.isOwner) {
    return NextResponse.redirect(new URL('/fans?fanvue_error=forbidden', req.url))
  }

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

  debugLog('callback: entered, exchanging code')
  try {
    const tokens = await exchangeCode(code, storedVerifier)
    debugLog(`callback: exchange ok, expires_at=${tokens.expires_at}, got_refresh_token=${!!tokens.refresh_token}`)

    // Fanvue only issues a new refresh_token on first consent — a reconnect legitimately
    // returns access_token only, so fall back to whichever one we already have on hand.
    const refreshToken = tokens.refresh_token
      || cookieStore.get('fv_refresh_token')?.value
      || cookieStore.get('fanvue_refresh_token')?.value
      || await getStoredRefreshToken()
      || undefined
    if (!refreshToken) {
      debugLog('callback: no refresh_token from exchange, cookies, or DB — aborting')
      throw new Error('no_refresh_token_available')
    }

    const secure = process.env.NODE_ENV === 'production'
    const maxAge = 60 * 60 * 24 * 30

    // Two client libraries read two different cookie names (fanvue.ts vs fanvue-server.ts) —
    // dual-write both until they're unified, so every route works after one real connect.
    cookieStore.set('fanvue_access_token', tokens.access_token, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_refresh_token', refreshToken, { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_expires_at', String(tokens.expires_at), { httpOnly: true, secure, maxAge })
    cookieStore.set('fanvue_connected', '1', { secure, maxAge })

    cookieStore.set('fv_access_token', tokens.access_token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge })
    cookieStore.set('fv_refresh_token', refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge })
    cookieStore.set('fv_expires_at', String(tokens.expires_at), { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge })
    cookieStore.set('fv_connected', '1', { secure, sameSite: 'lax', path: '/', maxAge })

    cookieStore.delete('fanvue_code_verifier')
    cookieStore.delete('fanvue_state')

    // Persist server-side too — cookies alone are unreachable from a cron/worker context,
    // which is what actually unblocks unattended multi-account automation.
    try {
      await saveFanvueConnectionToDb(tokens.access_token, refreshToken, tokens.expires_at)
      debugLog('callback: saveFanvueConnectionToDb ok')
    } catch (dbErr) {
      debugLog(`callback: saveFanvueConnectionToDb FAILED: ${dbErr instanceof Error ? (dbErr.stack ?? dbErr.message) : String(dbErr)}`)
      throw dbErr
    }
    await syncFanvueCreatorsToDb(tokens.access_token)
      .then(n => debugLog(`callback: syncFanvueCreatorsToDb ok, synced=${n}`))
      .catch(err => debugLog(`callback: syncFanvueCreatorsToDb FAILED (non-fatal): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))

    return NextResponse.redirect(new URL('/fans?connected=1', req.url))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    debugLog(`callback: FAILED overall: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    return NextResponse.redirect(new URL(`/fans?fanvue_error=${encodeURIComponent(msg)}`, req.url))
  }
}
