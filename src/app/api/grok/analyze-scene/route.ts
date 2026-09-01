import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { analyzeScenesForPrompts } from '@/lib/scene-analyze'

const MAX_IMAGES = 30

/** Per-image scene description for pins/clips that arrived with no prompt of their own. */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as { imageUrls?: unknown }
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : []
  if (!imageUrls.length) return NextResponse.json({ error: 'imageUrls required' }, { status: 400 })
  if (imageUrls.length > MAX_IMAGES) {
    return NextResponse.json({ error: `Max ${MAX_IMAGES} images per request` }, { status: 400 })
  }

  const prompts = await analyzeScenesForPrompts(imageUrls)
  return NextResponse.json({ prompts })
}
