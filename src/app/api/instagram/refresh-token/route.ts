import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { getSessionUser } from '@/lib/session'
import { refreshAccountToken, refreshDueTokens } from '@/lib/instagram/tokens'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { accountId?: string }
    const accountId = body.accountId

    if (!accountId) {
      if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'accountId required' }, { status: 400 })
      }
      const result = await refreshDueTokens()
      return NextResponse.json({ ok: true, ...result })
    }

    const user = await getSessionUser(req)
    if (user) {
      const owned = await one<{ id: string }>(
        `SELECT id FROM instagram_accounts WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)`,
        [accountId, user.id],
      )
      if (!owned) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    } else if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
      // Public allowlist on this route is for cron loopback; interactive refresh needs a session.
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }

    const result = await refreshAccountToken(accountId)
    if (!result.ok) {
      const status = result.code === 'tester_required' || result.code === 'reconnect_required' || result.code === 'expired'
        ? 409
        : 500
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, expiresAt: result.expiresAt })
  } catch (err) {
    console.error('[instagram/refresh-token]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
