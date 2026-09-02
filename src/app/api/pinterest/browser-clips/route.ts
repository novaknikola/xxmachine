import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireUser } from '@/lib/session'

interface ClipRow {
  id: string
  pin_key: string
  pin_url: string | null
  title: string | null
  image_url: string
  image_url_hd: string
  total_count: number
}

/**
 * Images saved through the browser extension — same pinterest_pins table as
 * the Pinterest tab, but scoped to `browser-clips*` boards (see
 * src/app/api/extension/clip/route.ts) and never mixed into that tab.
 * `?boardId=` narrows to one folder; omitted, every browser-clips board for
 * the user is shown together. Removing a clip and "Save to stories"/"Generate"
 * reuse the existing pinterest_pins/pinterest_stories routes — a pin id works
 * there regardless of which board it came from.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const params = req.nextUrl.searchParams
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const pageSize = Math.min(120, Math.max(1, Number(params.get('pageSize') ?? 48) || 48))
  const q = params.get('q')?.trim() ?? ''
  const boardId = params.get('boardId')?.trim() ?? ''

  const conditions = ["b.user_id = $1", "b.board_key LIKE 'browser-clips%'", 'b.is_active', 'p.is_active']
  const values: unknown[] = [auth.id]

  if (boardId) {
    values.push(boardId)
    conditions.push(`p.board_id = $${values.length}`)
  }
  if (q) {
    values.push(`%${q}%`)
    conditions.push(`p.title ILIKE $${values.length}`)
  }

  values.push(pageSize)
  const limitIdx = values.length
  values.push((page - 1) * pageSize)
  const offsetIdx = values.length

  const pins = await rows<ClipRow>(
    `SELECT p.id, p.pin_key, p.pin_url, p.title, p.image_url, p.image_url_hd,
            COUNT(*) OVER()::int AS total_count
       FROM pinterest_pins p
       JOIN pinterest_boards b ON b.id = p.board_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC, p.pin_key
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values,
  )

  const total = pins[0]?.total_count ?? 0
  return NextResponse.json({
    pins: pins.map(p => ({ ...p, total_count: undefined })),
    total,
    page,
    pageSize,
  })
}
