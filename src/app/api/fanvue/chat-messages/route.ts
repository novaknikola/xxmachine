import { NextRequest, NextResponse } from 'next/server'
import {
  FANVUE_API_BASE,
  getFanvueAccessToken,
  applyCookies,
  fanvueFetch,
} from '@/lib/fanvue-server'

interface FanvueMessage {
  uuid: string
  text: string | null
  sentAt: string | null
  sender?: { uuid: string; handle: string }
  recipient?: { uuid: string; handle: string }
  hasMedia?: boolean | null
  mediaType?: 'image' | 'video' | 'audio' | 'document' | null
  type?: string
  pricing?: { USD?: { price?: number } } | null
  purchasedAt?: string | null
  sentByUserId?: string | null
  isRead?: boolean
}

export interface ChatMessageLite {
  uuid: string
  fromCreator: boolean
  text: string
  sentAt: string | null
  hasMedia: boolean
  type: string | null
  ppvCents?: number
  purchased?: boolean
}

export async function POST(req: NextRequest) {
  const { accessToken, cookieDeltas } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json(
      { error: 'not_authenticated', authUrl: '/api/fanvue/auth' },
      { status: 401 },
    )
  }

  const body = await req.json().catch(() => null) as { userUuid?: string; limit?: number } | null
  const userUuid = body?.userUuid
  const limit = Math.max(1, Math.min(100, body?.limit ?? 50))
  if (!userUuid) {
    return NextResponse.json({ error: 'missing_userUuid' }, { status: 400 })
  }

  // Pull pages until we have `limit` messages or run out
  const all: FanvueMessage[] = []
  let page = 1
  while (all.length < limit && page <= 10) {
    const u = new URL(`${FANVUE_API_BASE}/chats/${userUuid}/messages`)
    u.searchParams.set('page', String(page))
    u.searchParams.set('size', String(Math.min(50, limit - all.length)))
    u.searchParams.set('markAsRead', 'false')
    const r = await fanvueFetch(u.toString(), accessToken)
    if (r.status === 429) {
      const res = NextResponse.json({ error: 'rate_limited' }, { status: 429 })
      applyCookies(res, cookieDeltas)
      return res
    }
    if (r.status === 403) {
      const res = NextResponse.json({
        error: 'missing_scope',
        detail: 'This call needs the read:chat scope. Add it to the Fanvue Builder Profile permissions and reconnect.',
      }, { status: 403 })
      applyCookies(res, cookieDeltas)
      return res
    }
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300)
      const res = NextResponse.json({ error: 'messages_failed', status: r.status, detail }, { status: 502 })
      applyCookies(res, cookieDeltas)
      return res
    }
    const data = await r.json() as {
      data?: FanvueMessage[]
      pagination?: { hasMore?: boolean }
    }
    const items = data.data ?? []
    all.push(...items)
    if (!data.pagination?.hasMore || items.length === 0) break
    page++
  }

  // Lightweight projection — strip noise the model doesn't need
  const messages: ChatMessageLite[] = all.map(m => ({
    uuid: m.uuid,
    fromCreator: !!m.sentByUserId, // Fanvue sets sentByUserId for creator-side sends
    text: m.text ?? '',
    sentAt: m.sentAt,
    hasMedia: !!m.hasMedia,
    type: m.type ?? null,
    ppvCents: m.pricing?.USD?.price,
    purchased: !!m.purchasedAt,
  })).reverse() // oldest first for narrative ordering

  const res = NextResponse.json({ ok: true, count: messages.length, messages })
  applyCookies(res, cookieDeltas)
  return res
}
