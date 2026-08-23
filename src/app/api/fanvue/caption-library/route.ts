import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import { requireOwner } from '@/lib/session'

// Read/reuse side of the caption library — writes happen only in /api/fanvue/caption,
// right when Grok generates one, so nothing is ever saved here directly.
export async function GET(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 100) || 100))

  const items = q
    ? await rows(
        `SELECT id, caption, category, structure, content_level AS "contentLevel",
                price_cents AS "priceCents", source_image_url AS "sourceImageUrl", created_at AS "createdAt"
           FROM fanvue_caption_library
          WHERE caption ILIKE $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [`%${q}%`, limit],
      )
    : await rows(
        `SELECT id, caption, category, structure, content_level AS "contentLevel",
                price_cents AS "priceCents", source_image_url AS "sourceImageUrl", created_at AS "createdAt"
           FROM fanvue_caption_library
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      )
  return NextResponse.json(items)
}

export async function DELETE(req: NextRequest) {
  const owner = await requireOwner(req)
  if (owner instanceof NextResponse) return owner

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 })
  await query(`DELETE FROM fanvue_caption_library WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
