import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { requireOwner } from '@/lib/session'
import { getFanvueAccessToken, applyCookies } from '@/lib/fanvue-server'
import { createFanvuePost } from '@/lib/fanvue-post'

interface RetryBody {
  caption?: string
  price?: number // cents; omit/undefined leaves it unpriced
  scheduledAt?: string
}

interface ExistingRow {
  id: string
  creator_uuid: string
  image_url: string
  extra_image_urls: string[] | null
  caption: string
  scheduled_at: string
  price_cents: number | null
}

// Edits a stuck 'failed' or 'pending' row (the old pre-rewrite architecture left some of these
// with no way forward except delete) and re-attempts the real Fanvue post creation in place —
// same row, not a new one, so it doesn't duplicate in the Zakazano list.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const { id } = await params
  const existing = await one<ExistingRow>(
    `SELECT id, creator_uuid, image_url, extra_image_urls, caption, scheduled_at, price_cents
       FROM fanvue_scheduled_posts WHERE id = $1`,
    [id],
  )
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null) as RetryBody | null
  const caption = body?.caption?.trim() || existing.caption
  const imageUrls = [existing.image_url, ...(existing.extra_image_urls ?? [])]
  const scheduledAt = body?.scheduledAt || existing.scheduled_at
  const priceCents = body?.price ?? existing.price_cents ?? undefined

  if (new Date(scheduledAt).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'scheduledAt_must_be_in_the_future' }, { status: 400 })
  }

  const { accessToken, cookieDeltas, error: tokenError } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json(
      { error: 'not_authenticated', detail: tokenError ?? null, authUrl: '/api/fanvue/auth' },
      { status: 401 },
    )
  }

  try {
    const postUuid = await createFanvuePost(
      accessToken,
      existing.creator_uuid,
      imageUrls,
      caption,
      'subscribers',
      priceCents,
      scheduledAt,
    )
    await one(
      `UPDATE fanvue_scheduled_posts
          SET caption = $1, scheduled_at = $2, price_cents = $3,
              status = 'scheduled', post_uuid = $4, error = NULL
        WHERE id = $5 RETURNING id`,
      [caption, scheduledAt, priceCents ?? null, postUuid, id],
    )
    const res = NextResponse.json({ ok: true, postUuid })
    applyCookies(res, cookieDeltas)
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    await one(
      `UPDATE fanvue_scheduled_posts
          SET caption = $1, scheduled_at = $2, price_cents = $3,
              status = 'failed', error = $4
        WHERE id = $5 RETURNING id`,
      [caption, scheduledAt, priceCents ?? null, msg, id],
    ).catch(() => {})
    const res = NextResponse.json({ error: 'schedule_failed', detail: msg }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }
}
