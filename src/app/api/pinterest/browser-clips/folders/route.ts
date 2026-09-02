import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireUser } from '@/lib/session'

interface FolderRow {
  id: string
  board_key: string
  title: string | null
  pin_count: number
}

/** Every browser-clips board (default + named folders) for the "Browser" tab's chip filter. */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const folders = await rows<FolderRow>(
    `SELECT id, board_key, title, pin_count
       FROM pinterest_boards
      WHERE user_id = $1 AND is_active AND board_key LIKE 'browser-clips%'
      ORDER BY (board_key = 'browser-clips') DESC, created_at DESC`,
    [auth.id],
  )
  return NextResponse.json({ folders })
}
