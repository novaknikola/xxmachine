import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireUser } from '@/lib/session'

interface PinRow {
  id: string
  board_id: string
  pin_key: string
  pin_url: string | null
  title: string | null
  image_url: string
  image_url_hd: string
  board_title: string | null
  board_key: string
  total_count: number
}

/**
 * Browse imported pins, optionally narrowed to one board.
 *
 * `q` searches pin and board titles — imported pins only. Pinterest renders its
 * own search client-side, so there is no server-side query we could forward to
 * without carrying a logged-in session.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const params = req.nextUrl.searchParams
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const pageSize = Math.min(120, Math.max(1, Number(params.get('pageSize') ?? 48) || 48))
  const boardId = params.get('boardId')?.trim() ?? ''
  const q = params.get('q')?.trim() ?? ''

  const conditions = ['b.user_id = $1', 'b.is_active', 'p.is_active']
  const values: unknown[] = [auth.id]

  if (boardId) {
    values.push(boardId)
    conditions.push(`p.board_id = $${values.length}`)
  }
  if (q) {
    values.push(`%${q}%`)
    conditions.push(`(p.title ILIKE $${values.length} OR b.title ILIKE $${values.length} OR b.board_key ILIKE $${values.length})`)
  }

  values.push(pageSize)
  const limitIdx = values.length
  values.push((page - 1) * pageSize)
  const offsetIdx = values.length

  const pins = await rows<PinRow>(
    `SELECT p.id, p.board_id, p.pin_key, p.pin_url, p.title, p.image_url, p.image_url_hd,
            b.title AS board_title, b.board_key,
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
    // total_count rides along on every row from the window function; it is
    // reported once rather than repeated in each pin.
    pins: pins.map(p => ({ ...p, total_count: undefined })),
    total,
    page,
    pageSize,
  })
}
