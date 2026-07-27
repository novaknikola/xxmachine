import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { requireUser } from '@/lib/session'

function normalizeUrlList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/[\n,]+/)
      : []
  return list
    .map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s))
    .slice(0, 9)
}

/**
 * User-facing face-ref editor for Copy-Paste Seedream.
 * Only characters bound to the caller's tracked profiles may be updated.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const characterId = req.nextUrl.searchParams.get('characterId')
  if (!characterId) {
    return NextResponse.json({ error: 'characterId required' }, { status: 400 })
  }

  const bound = await one<{ character_id: string }>(
    `SELECT character_id FROM tracked_profiles
      WHERE user_id = $1 AND character_id = $2
      LIMIT 1`,
    [user.id, characterId],
  )
  if (!bound) {
    return NextResponse.json({ error: 'Character not bound to your tracked profiles' }, { status: 403 })
  }

  const char = await one<{ id: string; name: string; faceRefUrls: string[] }>(
    `SELECT id, name, COALESCE(face_ref_urls, '{}') AS "faceRefUrls"
       FROM characters WHERE id = $1`,
    [characterId],
  )
  if (!char) return NextResponse.json({ error: 'Character not found' }, { status: 404 })
  return NextResponse.json({ character: char })
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    characterId?: string
    faceRefUrls?: unknown
  }
  const characterId = String(body.characterId ?? '').trim()
  if (!characterId) {
    return NextResponse.json({ error: 'characterId required' }, { status: 400 })
  }

  const bound = await one<{ character_id: string }>(
    `SELECT character_id FROM tracked_profiles
      WHERE user_id = $1 AND character_id = $2
      LIMIT 1`,
    [user.id, characterId],
  )
  if (!bound) {
    return NextResponse.json({ error: 'Character not bound to your tracked profiles' }, { status: 403 })
  }

  const faceRefUrls = normalizeUrlList(body.faceRefUrls)
  await query(
    `UPDATE characters SET face_ref_urls = $1 WHERE id = $2`,
    [faceRefUrls, characterId],
  )

  return NextResponse.json({ ok: true, faceRefUrls })
}
