import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

type Action = 'disconnect' | 'clear-proxy' | 'disconnect-and-clear-proxy' | 'delete'

export async function POST(req: NextRequest) {
  try {
    const { accountIds, action } = await req.json() as { accountIds: string[]; action: Action }
    if (!accountIds?.length) return NextResponse.json({ error: 'accountIds required' }, { status: 400 })
    if (!action) return NextResponse.json({ error: 'action required' }, { status: 400 })

    const ids = accountIds.map((_, i) => `$${i + 1}`).join(', ')

    if (action === 'disconnect') {
      await query(
        `UPDATE instagram_accounts SET ig_session = NULL, ig_access_token = NULL WHERE id IN (${ids})`,
        accountIds,
      )
    } else if (action === 'clear-proxy') {
      await query(
        `UPDATE instagram_accounts SET proxy_url = NULL WHERE id IN (${ids})`,
        accountIds,
      )
    } else if (action === 'disconnect-and-clear-proxy') {
      await query(
        `UPDATE instagram_accounts SET ig_session = NULL, ig_access_token = NULL, proxy_url = NULL WHERE id IN (${ids})`,
        accountIds,
      )
    } else if (action === 'delete') {
      await query(
        `DELETE FROM instagram_accounts WHERE id IN (${ids})`,
        accountIds,
      )
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ ok: true, affected: accountIds.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
