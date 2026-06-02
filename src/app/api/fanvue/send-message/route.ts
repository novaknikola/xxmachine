import { NextRequest, NextResponse } from 'next/server'
import {
  FANVUE_API_BASE,
  getFanvueAccessToken,
  applyCookies,
  fanvueFetch,
} from '@/lib/fanvue-server'

interface Body {
  userUuid?: string
  text?: string
  mediaUuids?: string[]
  price?: number | null
  templateUuid?: string
}

export async function POST(req: NextRequest) {
  const { accessToken, cookieDeltas } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json(
      { error: 'not_authenticated', authUrl: '/api/fanvue/auth' },
      { status: 401 },
    )
  }

  const body = await req.json().catch(() => null) as Body | null
  if (!body?.userUuid) return NextResponse.json({ error: 'missing_userUuid' }, { status: 400 })
  if (!body.text && !body.mediaUuids?.length && !body.templateUuid) {
    return NextResponse.json({ error: 'message_empty' }, { status: 400 })
  }

  const payload: Record<string, unknown> = {}
  if (body.text) payload.text = body.text
  if (body.mediaUuids?.length) payload.mediaUuids = body.mediaUuids
  if (typeof body.price === 'number' && body.price > 0) payload.price = body.price
  if (body.templateUuid) payload.templateUuid = body.templateUuid

  const r = await fanvueFetch(`${FANVUE_API_BASE}/chats/${body.userUuid}/message`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await r.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text.slice(0, 300) }

  if (r.status === 403) {
    const res = NextResponse.json({
      error: 'missing_scope',
      detail: 'Need write:chat scope. Add it to the Fanvue Builder Profile permissions and reconnect.',
    }, { status: 403 })
    applyCookies(res, cookieDeltas)
    return res
  }
  if (!r.ok) {
    const res = NextResponse.json({ error: 'send_failed', status: r.status, detail: data }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }

  const res = NextResponse.json({ ok: true, data })
  applyCookies(res, cookieDeltas)
  return res
}
