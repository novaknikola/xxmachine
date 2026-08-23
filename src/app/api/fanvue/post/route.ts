import { NextRequest, NextResponse } from 'next/server'
import { getFanvueAccessToken, applyCookies, type CookieDelta } from '@/lib/fanvue-server'
import { getFanvueAccessTokenFromDb } from '@/lib/fanvue-db-token'
import { createFanvuePost } from '@/lib/fanvue-post'
import { requireOwner } from '@/lib/session'

interface Body {
  creatorUuid?: string
  imageUrl?: string
  caption?: string
  audience?: 'subscribers' | 'followers-and-subscribers'
  price?: number // cents; Fanvue's real minimum is 300
  publishAt?: string // ISO datetime — Fanvue schedules and fires it, not our cron
  dryRun?: boolean
}

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  // Two callers: the owner's browser (session cookie, cookie-stored Fanvue token) and the
  // internal cron→publish/now path (no session, no cookies at all — must use the DB-persisted
  // token instead). Distinguish by the same x-cron-secret header queue/process/[id] already uses.
  const isCronCall = !!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET

  let accessToken: string | null
  let cookieDeltas: CookieDelta[] = []
  if (isCronCall) {
    accessToken = await getFanvueAccessTokenFromDb()
  } else {
    const owner = await requireOwner(req)
    if (owner instanceof NextResponse) return owner
    ;({ accessToken, cookieDeltas } = await getFanvueAccessToken(req))
  }
  if (!accessToken) {
    return NextResponse.json({ error: 'not_authenticated', authUrl: '/api/fanvue/auth' }, { status: 401 })
  }

  const body = await req.json().catch(() => null) as Body | null
  if (!body?.creatorUuid || !body.imageUrl || !body.caption) {
    return NextResponse.json({ error: 'missing_creatorUuid_imageUrl_or_caption' }, { status: 400 })
  }

  if (body.dryRun) {
    const imgRes = await fetch(body.imageUrl, { method: 'HEAD' }).catch(() => null)
    const res = NextResponse.json({
      ok: true,
      dryRun: true,
      wouldPost: {
        creatorUuid: body.creatorUuid,
        caption: body.caption,
        audience: body.audience ?? 'subscribers',
        price: body.price ?? null,
        publishAt: body.publishAt ?? null,
        imageReachable: !!imgRes?.ok,
        imageStatus: imgRes?.status ?? null,
      },
    })
    applyCookies(res, cookieDeltas)
    return res
  }

  try {
    const postUuid = await createFanvuePost(
      accessToken,
      body.creatorUuid,
      body.imageUrl,
      body.caption,
      body.audience ?? 'subscribers',
      body.price,
      body.publishAt,
    )
    const res = NextResponse.json({ ok: true, postUuid })
    applyCookies(res, cookieDeltas)
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    const cause = err instanceof Error && err.cause ? String(err.cause) : null
    console.error('[fanvue/post] failed:', err)
    const res = NextResponse.json({ error: 'post_failed', detail: msg, cause }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }
}
