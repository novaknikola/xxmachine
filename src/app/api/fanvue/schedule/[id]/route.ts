import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { requireOwner } from '@/lib/session'
import { getFanvueAccessToken, applyCookies } from '@/lib/fanvue-server'
import { createFanvuePost } from '@/lib/fanvue-post'

interface RetryBody {
  caption?: string
  price?: number // cents; omit/undefined leaves it unpriced
  scheduledAt?: string
  imageUrl?: string
}

interface ExistingRow {
  id: string
  creator_uuid: string
  image_url: string
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
    `SELECT id, creator_uuid, image_url, caption, scheduled_at, price_cents
       FROM fanvue_scheduled_posts WHERE id = $1`,
    [id],
  )
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null) as RetryBody | null
  const caption = body?.caption?.trim() || existing.caption
  const imageUrl = body?.imageUrl?.trim() || existing.image_url
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
      imageUrl,
      caption,
      'subscribers',
      priceCents,
      scheduledAt,
    )
    await one(
      `UPDATE fanvue_scheduled_posts
          SET image_url = $1, caption = $2, scheduled_at = $3, price_cents = $4,
              status = 'scheduled', post_uuid = $5, error = NULL
        WHERE id = $6 RETURNING id`,
      [imageUrl, caption, scheduledAt, priceCents ?? null, postUuid, id],
    )
    const res = NextResponse.json({ ok: true, postUuid })
    applyCookies(res, cookieDeltas)
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    await one(
      `UPDATE fanvue_scheduled_posts
          SET image_url = $1, caption = $2, scheduled_at = $3, price_cents = $4,
              status = 'failed', error = $5
        WHERE id = $6 RETURNING id`,
      [imageUrl, caption, scheduledAt, priceCents ?? null, msg, id],
    ).catch(() => {})
    const res = NextResponse.json({ error: 'schedule_failed', detail: msg }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }
}
