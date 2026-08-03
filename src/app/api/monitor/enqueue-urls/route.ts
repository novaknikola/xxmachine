import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { enqueueReelUrlsForUser, EnqueueUrlsError } from '@/lib/monitor/enqueue-from-urls'

/**
 * Paste reel URLs → resolve (cache → download → profile list) → enqueue → auto-classify.
 * No character/profile binding is required — Copy-Paste v2 uses a per-batch reference photo.
 *
 * The resolving itself lives in enqueue-from-urls so the Telegram bot can run
 * the same path, which has no session to authenticate with.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    username?: string
    sourceUsername?: string
    urls?: string | string[]
    text?: string
    referenceImageUrl?: string
  }

  const rawText = Array.isArray(body.urls)
    ? body.urls.join('\n')
    : String(body.urls ?? body.text ?? '')

  try {
    const result = await enqueueReelUrlsForUser({
      userId: user.id,
      rawText,
      username: body.username,
      sourceUsername: body.sourceUsername,
      referenceImageUrl: body.referenceImageUrl,
    })
    return NextResponse.json({ ok: true, classifying: true, ...result })
  } catch (err) {
    if (err instanceof EnqueueUrlsError) {
      return NextResponse.json({ error: err.message, ...err.detail }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Enqueue failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
