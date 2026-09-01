import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { requireApiToken } from '@/lib/api-token'

const CLIP_BOARD_KEY = 'browser-clips'

/**
 * One synthetic board per user, reusing the pinterest_boards/pinterest_pins
 * schema so the whole existing Pinterest tab (browse, search, select, Save to
 * stories, Generate) works on extension clips with zero new UI. board_url is
 * a sentinel, not a real Pinterest board — the tab's "Re-sync" button will
 * fail harmlessly against it (see pinterest-tab.tsx, which hides it for this
 * board_key), it does not touch the pins already saved here.
 */
async function getOrCreateClipBoard(userId: string): Promise<string> {
  const existing = await one<{ id: string }>(
    `select id from pinterest_boards where user_id = $1 and board_key = $2`,
    [userId, CLIP_BOARD_KEY],
  )
  if (existing) return existing.id

  const created = await one<{ id: string }>(
    `insert into pinterest_boards (user_id, board_key, owner, slug, title, board_url)
     values ($1, $2, 'browser', 'clips', 'Browser Clips', 'extension://clips')
     on conflict (user_id, board_key) do update set is_active = true
     returning id`,
    [userId, CLIP_BOARD_KEY],
  )
  return created!.id
}

/** Whether the token is valid, without saving anything — the extension's "Test connection". */
export async function GET(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth
  return NextResponse.json({ ok: true, email: auth.email })
}

export async function POST(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as {
    imageUrl?: string
    pageUrl?: string
    title?: string
  }

  const imageUrl = String(body.imageUrl ?? '').trim()
  if (!/^https?:\/\//i.test(imageUrl)) {
    return NextResponse.json(
      { error: 'imageUrl must be an http(s) URL — data:/blob: images are not supported' },
      { status: 400 },
    )
  }
  const pageUrl = body.pageUrl ? String(body.pageUrl).trim().slice(0, 2000) : null
  const title = body.title ? String(body.title).trim().slice(0, 300) : null

  const boardId = await getOrCreateClipBoard(auth.id)
  // Hash of the URL, not a Pinterest pin id — clipping the same image twice
  // updates the one row instead of duplicating it.
  const pinKey = createHash('sha1').update(imageUrl).digest('hex')

  const before = await one<{ id: string }>(
    `select id from pinterest_pins where board_id = $1 and pin_key = $2`,
    [boardId, pinKey],
  )

  const saved = await one<{ id: string }>(
    `insert into pinterest_pins (board_id, pin_key, pin_url, title, image_url, image_url_hd)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (board_id, pin_key) do update
       set title = coalesce(excluded.title, pinterest_pins.title),
           pin_url = coalesce(excluded.pin_url, pinterest_pins.pin_url),
           is_active = true
     returning id`,
    [boardId, pinKey, pageUrl, title, imageUrl],
  )

  await query(
    `update pinterest_boards
        set pin_count = (select count(*) from pinterest_pins where board_id = $1 and is_active)
      where id = $1`,
    [boardId],
  )

  return NextResponse.json({ ok: true, pinId: saved!.id, alreadySaved: !!before })
}
