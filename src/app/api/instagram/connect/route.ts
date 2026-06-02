import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { getIgClient, saveIgSession, loginIgClient } from '@/lib/ig-private-api'

export async function POST(req: NextRequest) {
  try {
    const { accountId, checkpointCode } = await req.json()
    if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

    const acc = await one<{
      id: string
      name: string
      ig_username: string | null
      ig_password: string | null
      ig_totp_secret: string | null
      ig_session: object | null
    }>(`SELECT id, name, ig_username, ig_password, ig_totp_secret, ig_session FROM instagram_accounts WHERE id=$1`, [accountId])

    if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const hasBrowserSession = !!acc.ig_session &&
      typeof (acc.ig_session as Record<string, unknown>).sessionid === 'string'

    if (!acc.ig_username || !acc.ig_password) {
      if (!hasBrowserSession) {
        return NextResponse.json({ error: 'Missing credentials — set ig_username and ig_password first' }, { status: 400 })
      }
      // Browser session is already captured — accept as connected without API verification.
      // The sessionid cookie can't be easily used by instagram-private-api (different format),
      // so we trust it and let posting reveal if the session expired.
      const session = acc.ig_session as Record<string, unknown>
      const username = acc.ig_username
        ?? `user_${((session.dsUserId as string) ?? accountId).slice(0, 8)}`
      if (!acc.ig_username) {
        await one(`UPDATE instagram_accounts SET ig_username=$1 WHERE id=$2`, [username, accountId])
      }
      return NextResponse.json({ ok: true, username })
    }

    const ig = await getIgClient(accountId)

    if (checkpointCode) {
      await ig.challenge.sendSecurityCode(checkpointCode)
      await saveIgSession(accountId, ig)
      const user = await ig.account.currentUser()
      await one(
        `UPDATE instagram_accounts SET ig_username=$1 WHERE id=$2`,
        [user.username, accountId]
      )
      return NextResponse.json({ ok: true, username: user.username })
    }

    const loggedIn = await loginIgClient(ig, acc.ig_username, acc.ig_password, acc.ig_totp_secret)
    await saveIgSession(accountId, ig)
    await one(
      `UPDATE instagram_accounts SET ig_username=$1 WHERE id=$2`,
      [loggedIn.username, accountId]
    )

    return NextResponse.json({ ok: true, username: loggedIn.username })
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'CHECKPOINT') {
      return NextResponse.json({ checkpoint: true, error: 'Instagram requires verification — check your email/SMS for a code' }, { status: 202 })
    }
    console.error('[instagram/connect]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get('accountId')
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

  try {
    const ig = await getIgClient(accountId)
    const user = await ig.account.currentUser()
    return NextResponse.json({ connected: true, username: user.username, fullName: user.full_name })
  } catch {
    return NextResponse.json({ connected: false })
  }
}
