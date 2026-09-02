import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { requireApiToken } from '@/lib/api-token'

const DEFAULT_BOARD_KEY = 'browser-clips'
const MAX_IMAGES_PER_REQUEST = 200

function slugifyFolder(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'folder'
}

/**
 * One board per user by default ("Browser Clips"), or one per named folder
 * ("browser-clips:<slug>") when the extension's bulk-grab supplies a folder
 * name — reusing the pinterest_boards/pinterest_pins schema so the whole
 * existing Pinterest-tab machinery (browse, search, select, Save to stories,
 * Generate) works on extension clips with zero new UI there. board_url is a
 * sentinel, not a real Pinterest board — the tab's "Re-sync" button will
 * fail harmlessly against it (see pinterest-tab.tsx, which hides it for any
 * board_key starting with "browser-clips"), it does not touch saved pins.
 */
async function getOrCreateClipBoard(userId: string, folderName?: string): Promise<string> {
  const folder = folderName?.trim().slice(0, 80)
  const boardKey = folder ? `browser-clips:${slugifyFolder(folder)}` : DEFAULT_BOARD_KEY
  const title = folder || 'Browser Clips'

  const existing = await one<{ id: string }>(
    `select id from pinterest_boards where user_id = $1 and board_key = $2`,
    [userId, boardKey],
  )
  if (existing) return existing.id

  const created = await one<{ id: string }>(
    `insert into pinterest_boards (user_id, board_key, owner, slug, title, board_url)
     values ($1, $2, 'browser', 'clips', $3, 'extension://clips')
     on conflict (user_id, board_key) do update set is_active = true
     returning id`,
    [userId, boardKey, title],
  )
  return created!.id
}

/** Whether the token is valid, without saving anything — the extension's "Test connection". */
export async function GET(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth
  return NextResponse.json({ ok: true, email: auth.email })
}

/**
 * Saves one image (hover-button / context-menu path) or many at once
 * (bulk "grab all images on this page" path) — same shape either way, just
 * `imageUrl` vs `imageUrls`. An optional `folder` files them under a named
 * board instead of the default "Browser Clips" one.
 */
export async function POST(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as {
    imageUrl?: string
    imageUrls?: string[]
    folder?: string
    pageUrl?: string
    title?: string
  }

  const rawUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls
    : body.imageUrl ? [body.imageUrl] : []
  const urls = [...new Set(
    rawUrls
      .filter((u): u is string => typeof u === 'string')
      .map(u => u.trim())
      .filter(u => /^https?:\/\//i.test(u)),
  )]

  if (!urls.length) {
    return NextResponse.json(
      { error: 'No valid http(s) image URL(s) — data:/blob: images are not supported' },
      { status: 400 },
    )
  }
  if (urls.length > MAX_IMAGES_PER_REQUEST) {
    return NextResponse.json({ error: `Max ${MAX_IMAGES_PER_REQUEST} images per request` }, { status: 400 })
  }

  const pageUrl = body.pageUrl ? String(body.pageUrl).trim().slice(0, 2000) : null
  const title = body.title ? String(body.title).trim().slice(0, 300) : null
  const boardId = await getOrCreateClipBoard(auth.id, body.folder)

  let saved = 0
  let alreadySaved = 0
  for (const imageUrl of urls) {
    // Hash of the URL, not a Pinterest pin id — clipping the same image
    // twice updates the one row instead of duplicating it.
    const pinKey = createHash('sha1').update(imageUrl).digest('hex')
    const before = await one<{ id: string }>(
      `select id from pinterest_pins where board_id = $1 and pin_key = $2`,
      [boardId, pinKey],
    )
    await one(
      `insert into pinterest_pins (board_id, pin_key, pin_url, title, image_url, image_url_hd)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (board_id, pin_key) do update
         set title = coalesce(excluded.title, pinterest_pins.title),
             pin_url = coalesce(excluded.pin_url, pinterest_pins.pin_url),
             is_active = true
       returning id`,
      [boardId, pinKey, pageUrl, title, imageUrl],
    )
    if (before) alreadySaved++
    else saved++
  }

  await query(
    `update pinterest_boards
        set pin_count = (select count(*) from pinterest_pins where board_id = $1 and is_active)
      where id = $1`,
    [boardId],
  )

  return NextResponse.json({ ok: true, saved, alreadySaved, total: urls.length })
}
