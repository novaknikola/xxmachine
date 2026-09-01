import { NextRequest, NextResponse } from 'next/server'
import { one, rows, query } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { fetchBoard, parseBoardRef, PinterestError, explainEmptyBoard } from '@/lib/pinterest'

interface BoardRow {
  id: string
  board_key: string
  owner: string
  slug: string
  title: string | null
  board_url: string
  pin_count: number
  synced_at: string | null
  last_error: string | null
}

/** Boards this user has imported, newest sync first. */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const boards = await rows<BoardRow>(
    `SELECT id, board_key, owner, slug, title, board_url, pin_count, synced_at, last_error
       FROM pinterest_boards
      WHERE user_id = $1 AND is_active AND board_key <> 'browser-clips'
      ORDER BY synced_at DESC NULLS LAST, created_at DESC`,
    [auth.id],
  )
  return NextResponse.json({ boards })
}

/**
 * Import or re-sync a board. Re-running is safe and is the normal way to pick
 * up new pins: rows are upserted on (board_id, pin_key), so existing pins keep
 * their id and nothing is duplicated.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as { url?: string }

  let ref
  try {
    ref = parseBoardRef(String(body.url ?? ''))
  } catch (err) {
    const msg = err instanceof PinterestError ? err.message : 'Invalid board URL'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const board = await one<{ id: string }>(
    `INSERT INTO pinterest_boards (user_id, board_key, owner, slug, board_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, board_key)
       DO UPDATE SET is_active = true, board_url = EXCLUDED.board_url
     RETURNING id`,
    [auth.id, ref.boardKey, ref.owner, ref.slug, ref.boardUrl],
  )
  const boardId = board!.id

  try {
    const fetched = await fetchBoard(ref)
    if (!fetched.pins.length) {
      // Say what was actually seen. "Empty or private" was a guess, and it sent
      // people checking a board that was fine.
      console.warn('[pinterest/boards] no pins:', ref.boardKey, JSON.stringify(fetched.diagnostics))
      throw new PinterestError(explainEmptyBoard(fetched.diagnostics))
    }

    for (const pin of fetched.pins) {
      await query(
        `INSERT INTO pinterest_pins (board_id, pin_key, pin_url, title, image_url, image_url_hd)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (board_id, pin_key) DO UPDATE
           SET title = COALESCE(EXCLUDED.title, pinterest_pins.title),
               pin_url = COALESCE(EXCLUDED.pin_url, pinterest_pins.pin_url)`,
        // is_active is deliberately not touched: a pin you deleted must stay
        // deleted when the board is re-synced, and the pin is still on
        // Pinterest so every sync would otherwise resurrect it.
        [boardId, pin.pinKey, pin.pinUrl, pin.title, pin.imageUrl, pin.imageUrlHd],
      )
    }

    const counted = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pinterest_pins WHERE board_id = $1 AND is_active`,
      [boardId],
    )
    await query(
      `UPDATE pinterest_boards
          SET title = COALESCE($2, title), pin_count = $3, synced_at = now(), last_error = NULL
        WHERE id = $1`,
      [boardId, fetched.title, counted!.n],
    )

    return NextResponse.json({
      id: boardId,
      boardKey: ref.boardKey,
      title: fetched.title,
      imported: fetched.pins.length,
      pinCount: counted!.n,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Import failed'
    // Kept on the row so the tab can show why a board is empty instead of
    // silently listing nothing.
    await query(`UPDATE pinterest_boards SET last_error = $2 WHERE id = $1`, [boardId, msg])
    console.error('[pinterest/boards] import failed:', msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}

/** Remove a board and its pins from the library. */
export async function DELETE(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const res = await query(`DELETE FROM pinterest_boards WHERE id = $1 AND user_id = $2`, [id, auth.id])
  if (!res.rowCount) return NextResponse.json({ error: 'Board not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
