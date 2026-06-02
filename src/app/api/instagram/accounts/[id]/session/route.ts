import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { sessionid, dsUserId } = await req.json()

    if (!sessionid?.trim()) {
      return NextResponse.json({ error: 'sessionid is required' }, { status: 400 })
    }

    const sid = sessionid.trim()
    // ds_user_id can often be extracted from the sessionid prefix (numeric part before %)
    const inferredUserId = dsUserId?.trim() || sid.split('%')[0].split(':')[0] || null

    const rawSession = {
      cookies: [
        { name: 'sessionid', value: sid, domain: '.instagram.com', path: '/' },
        ...(inferredUserId ? [{ name: 'ds_user_id', value: inferredUserId, domain: '.instagram.com', path: '/' }] : []),
      ],
      sessionid: sid,
      dsUserId: inferredUserId,
    }

    const acc = await one<{ id: string; name: string; ig_username: string | null }>(
      `UPDATE instagram_accounts SET ig_session=$1 WHERE id=$2 RETURNING id, name, ig_username`,
      [JSON.stringify(rawSession), id]
    )

    if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    return NextResponse.json({ ok: true, username: acc.ig_username, name: acc.name })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
