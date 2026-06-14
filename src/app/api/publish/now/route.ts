import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { sendPhoto, sendText, editMessageReplyMarkup, editMessageCaption } from '@/lib/telegram'

const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID!

export async function POST(req: NextRequest) {
  const { postId } = await req.json()
  if (!postId) return NextResponse.json({ error: 'Missing postId' }, { status: 400 })

  const post = await one<{
    id: string; character_id: string; character_name: string; image_url: string;
    caption: string; platforms: string[]; telegram_message_id: number | null;
    status: string;
  }>('SELECT * FROM scheduled_posts WHERE id=$1', [postId])

  if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (post.status === 'published') return NextResponse.json({ ok: true, already: true })

  const results: string[] = []
  const errors: string[] = []

  // ── Telegram channel ────────────────────────────────────────────
  if (post.platforms.includes('telegram')) {
    const char = await one<{ telegram_channel_id: string | null }>(
  'SELECT telegram_channel_id FROM characters WHERE id=$1',
  [post.character_id]
)
const channelId = char?.telegram_channel_id
    if (channelId) {
      try {
        await sendPhoto(channelId, post.image_url, post.caption)
        results.push('Telegram')
      } catch (e) {
        errors.push(`Telegram: ${e instanceof Error ? e.message : 'unknown'}`)
      }
    } else {
      errors.push('Telegram: no channel ID configured for this character')
    }
  }

  // ── Fanvue ──────────────────────────────────────────────────────
  if (post.platforms.includes('fanvue')) {
    try {
      // Fanvue posting requires a valid session token stored in cookies.
      // We call the internal Fanvue post endpoint which handles token refresh.
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/fanvue/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: post.image_url, caption: post.caption }),
      })
      if (!res.ok) throw new Error(await res.text())
      results.push('Fanvue')
    } catch (e) {
      errors.push(`Fanvue: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  const success = errors.length === 0
  const newStatus = success ? 'published' : 'failed'

  await query(
    `UPDATE scheduled_posts SET status=$1, published_at=$2, error=$3 WHERE id=$4`,
    [newStatus, success ? new Date().toISOString() : null, errors.join('; ') || null, postId],
  )

  // Edit bot preview message to show result
  if (ADMIN_GROUP && post.telegram_message_id) {
    const statusLine = success
      ? `✅ Published to: ${results.join(', ')}`
      : `❌ Failed: ${errors.join(' | ')}`
    try {
      await editMessageCaption(ADMIN_GROUP, post.telegram_message_id,
        `📸 <b>${post.character_name}</b>\n${statusLine}\n\n${post.caption}`)
      await editMessageReplyMarkup(ADMIN_GROUP, post.telegram_message_id, { inline_keyboard: [] })
    } catch {}
  }

  if (!success && ADMIN_GROUP) {
    await sendText(ADMIN_GROUP, `❌ Publish failed for <b>${post.character_name}</b>:\n${errors.join('\n')}`)
  }

  return NextResponse.json({ ok: success, results, errors })
}
