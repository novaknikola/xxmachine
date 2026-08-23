import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { requireOwner } from '@/lib/session'
import { getFanvueAccessToken, applyCookies } from '@/lib/fanvue-server'
import { createFanvuePost } from '@/lib/fanvue-post'

interface CreateBody {
  creatorUuid?: string
  creatorDisplayName?: string
  imageUrl?: string
  caption?: string
  scheduledAt?: string
  price?: number // cents; Fanvue's real minimum is 300
}

const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const { searchParams } = new URL(req.url)
  const offset = Math.max(0, Number(searchParams.get('offset') ?? 0) || 0)
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? PAGE_SIZE) || PAGE_SIZE))

  const [items, totalRow] = await Promise.all([
    rows(
      `SELECT id, creator_uuid AS "creatorUuid", creator_display_name AS "creatorDisplayName",
              image_url AS "imageUrl", caption, scheduled_at AS "scheduledAt", status, error,
              published_at AS "publishedAt", post_uuid AS "postUuid", price_cents AS "priceCents",
              created_at AS "createdAt"
         FROM fanvue_scheduled_posts
        ORDER BY scheduled_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    one<{ count: string }>(`SELECT count(*)::text AS count FROM fanvue_scheduled_posts`),
  ])
  return NextResponse.json({ items, total: Number(totalRow?.count ?? 0), offset, limit })
}

// Bulk delete — body: { ids: string[] }. Single-row delete lives at schedule/[id] (DELETE).
export async function DELETE(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const body = await req.json().catch(() => null) as { ids?: string[] } | null
  const ids = (body?.ids ?? []).filter(Boolean)
  if (!ids.length) {
    return NextResponse.json({ error: 'missing_ids' }, { status: 400 })
  }
  await query(`DELETE FROM fanvue_scheduled_posts WHERE id = ANY($1::uuid[])`, [ids])
  return NextResponse.json({ ok: true, deleted: ids.length })
}

// Calls Fanvue's create-post with `publishAt` right away — Fanvue holds and fires the post
// itself (visible in their own scheduled-post queue), so xxmachine being down later doesn't
// stop it from going out. Replaces the old "insert a pending row, let our own cron fire it
// later" design, which meant a dead xxmachine server silently stalled everything.
export async function POST(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const body = await req.json().catch(() => null) as CreateBody | null
  if (!body?.creatorUuid || !body.imageUrl || !body.caption || !body.scheduledAt) {
    return NextResponse.json({ error: 'missing_creatorUuid_imageUrl_caption_or_scheduledAt' }, { status: 400 })
  }
  if (new Date(body.scheduledAt).getTime() <= Date.now()) {
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
      body.creatorUuid,
      body.imageUrl,
      body.caption,
      'subscribers',
      body.price,
      body.scheduledAt,
    )
    const row = await one<{ id: string }>(
      `INSERT INTO fanvue_scheduled_posts
        (creator_uuid, creator_display_name, image_url, caption, scheduled_at, price_cents, status, post_uuid)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)
       RETURNING id`,
      [body.creatorUuid, body.creatorDisplayName ?? null, body.imageUrl, body.caption, body.scheduledAt, body.price ?? null, postUuid],
    )
    const res = NextResponse.json({ ok: true, id: row?.id, postUuid })
    applyCookies(res, cookieDeltas)
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error'
    // Recorded as failed (not silently dropped) so it still shows up in the Zakazano list —
    // matches how every other failure in this pipeline stays visible instead of vanishing.
    await one(
      `INSERT INTO fanvue_scheduled_posts
        (creator_uuid, creator_display_name, image_url, caption, scheduled_at, price_cents, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7)
       RETURNING id`,
      [body.creatorUuid, body.creatorDisplayName ?? null, body.imageUrl, body.caption, body.scheduledAt, body.price ?? null, msg],
    ).catch(() => {})
    const res = NextResponse.json({ error: 'schedule_failed', detail: msg }, { status: 502 })
    applyCookies(res, cookieDeltas)
    return res
  }
}
