import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const { accountId } = await req.json()
    if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

    const account = await one<{ ig_access_token: string | null }>(
      `SELECT ig_access_token FROM instagram_accounts WHERE id=$1`,
      [accountId]
    )
    if (!account?.ig_access_token) {
      return NextResponse.json({ error: 'Account not connected via OAuth' }, { status: 400 })
    }

    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.ig_access_token}`
    )
    const data = await res.json()
    if (!res.ok || !data.access_token) {
      throw new Error(data.error?.message ?? 'Refresh failed')
    }

    const expiresIn: number = data.expires_in ?? 5184000
    const expiresAt = new Date(Date.now() + expiresIn * 1000)

    await one(
      `UPDATE instagram_accounts SET ig_access_token=$1, ig_token_expires_at=$2 WHERE id=$3`,
      [data.access_token, expiresAt.toISOString(), accountId]
    )

    return NextResponse.json({ ok: true, expiresAt: expiresAt.toISOString() })
  } catch (err) {
    console.error('[instagram/refresh-token]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
