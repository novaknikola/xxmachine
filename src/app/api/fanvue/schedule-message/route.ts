import { NextRequest, NextResponse } from 'next/server'
import {
  FANVUE_API_BASE,
  getFanvueAccessToken,
  applyCookies,
  fanvueFetch,
} from '@/lib/fanvue-server'

interface ScheduleBody {
  userUuid?: string
  text?: string
  mediaUuids?: string[]
  price?: number | null
  scheduledAt?: string // ISO timestamp
  listName?: string    // e.g. "sched-2026-05-08-john"
}

interface DeleteBody {
  massMessageUuid?: string
  customListUuid?: string
}

export async function POST(req: NextRequest) {
  const { accessToken, cookieDeltas } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json({ error: 'not_authenticated', authUrl: '/api/fanvue/auth' }, { status: 401 })
  }
  const body = await req.json().catch(() => null) as ScheduleBody | null
  if (!body?.userUuid || !body.scheduledAt) {
    return NextResponse.json({ error: 'missing userUuid or scheduledAt' }, { status: 400 })
  }
  if (!body.text && !body.mediaUuids?.length) {
    return NextResponse.json({ error: 'message_empty' }, { status: 400 })
  }

  // 1) Create temp custom list
  const listName = body.listName || `xx-sched-${Date.now()}`
  const createListRes = await fanvueFetch(`${FANVUE_API_BASE}/chats/lists/custom`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: listName }),
  })
  if (!createListRes.ok) {
    const detail = (await createListRes.text().catch(() => '')).slice(0, 300)
    const res = NextResponse.json(
      { error: 'create_list_failed', status: createListRes.status, detail },
      { status: 502 },
    )
    applyCookies(res, cookieDeltas)
    return res
  }
  const listData = await createListRes.json() as { uuid?: string }
  const customListUuid = listData.uuid
  if (!customListUuid) {
    const res = NextResponse.json({ error: 'list_no_uuid' }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }

  // 2) Add the fan as the only member
  const addRes = await fanvueFetch(
    `${FANVUE_API_BASE}/chats/lists/custom/${customListUuid}/members`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUuids: [body.userUuid] }),
    },
  )
  if (!addRes.ok) {
    const detail = (await addRes.text().catch(() => '')).slice(0, 300)
    // Try to clean up the empty list
    await fanvueFetch(`${FANVUE_API_BASE}/chats/lists/custom/${customListUuid}`, accessToken, { method: 'DELETE' }).catch(() => {})
    const res = NextResponse.json(
      { error: 'add_member_failed', status: addRes.status, detail },
      { status: 502 },
    )
    applyCookies(res, cookieDeltas)
    return res
  }

  // 3) Create scheduled mass message targeting that list
  const massPayload: Record<string, unknown> = {
    includedLists: { customListUuids: [customListUuid] },
    scheduledAt: body.scheduledAt,
  }
  if (body.text) massPayload.text = body.text
  if (body.mediaUuids?.length) massPayload.mediaUuids = body.mediaUuids
  if (typeof body.price === 'number' && body.price > 0) massPayload.price = body.price

  const massRes = await fanvueFetch(`${FANVUE_API_BASE}/chats/mass-messages`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(massPayload),
  })
  const massText = await massRes.text()
  let massData: unknown
  try { massData = JSON.parse(massText) } catch { massData = massText.slice(0, 300) }

  if (!massRes.ok) {
    // Roll back — delete the temp list
    await fanvueFetch(`${FANVUE_API_BASE}/chats/lists/custom/${customListUuid}`, accessToken, { method: 'DELETE' }).catch(() => {})
    const res = NextResponse.json(
      { error: 'schedule_failed', status: massRes.status, detail: massData, customListUuid },
      { status: 502 },
    )
    applyCookies(res, cookieDeltas)
    return res
  }

  const massMessageUuid = (massData as { uuid?: string; messageUuid?: string })?.uuid
    ?? (massData as { messageUuid?: string })?.messageUuid

  const res = NextResponse.json({ ok: true, customListUuid, massMessageUuid, raw: massData })
  applyCookies(res, cookieDeltas)
  return res
}

export async function DELETE(req: NextRequest) {
  const { accessToken, cookieDeltas } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json({ error: 'not_authenticated', authUrl: '/api/fanvue/auth' }, { status: 401 })
  }
  const body = await req.json().catch(() => null) as DeleteBody | null
  const errors: string[] = []
  if (body?.massMessageUuid) {
    const r = await fanvueFetch(`${FANVUE_API_BASE}/chats/mass-messages/${body.massMessageUuid}`, accessToken, { method: 'DELETE' })
    if (!r.ok && r.status !== 404) errors.push(`mass:${r.status}`)
  }
  if (body?.customListUuid) {
    const r = await fanvueFetch(`${FANVUE_API_BASE}/chats/lists/custom/${body.customListUuid}`, accessToken, { method: 'DELETE' })
    if (!r.ok && r.status !== 404) errors.push(`list:${r.status}`)
  }
  const res = NextResponse.json(errors.length ? { ok: false, errors } : { ok: true })
  applyCookies(res, cookieDeltas)
  return res
}
