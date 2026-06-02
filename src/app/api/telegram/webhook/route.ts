import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { answerCallbackQuery, editMessageCaption, editMessageReplyMarkup, sendText } from '@/lib/telegram'

const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID!
const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  // Verify webhook secret
  const secret = req.nextUrl.searchParams.get('secret')
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const callbackQuery = body.callback_query
  if (!callbackQuery) return NextResponse.json({ ok: true })

  const { id: callbackId, data, message } = callbackQuery
  const [action, postId] = (data as string).split(':')

  if (!postId || !['approve', 'reject'].includes(action)) {
    await answerCallbackQuery(callbackId, 'Unknown action')
    return NextResponse.json({ ok: true })
  }

  const post = await one<{
    id: string; character_name: string; image_url: string; caption: string;
    status: string; scheduled_at: string; platforms: string[];
  }>('SELECT * FROM scheduled_posts WHERE id=$1', [postId])

  if (!post || post.status !== 'pending_approval') {
    await answerCallbackQuery(callbackId, 'Post already processed')
    return NextResponse.json({ ok: true })
  }

  if (action === 'reject') {
    await query(`UPDATE scheduled_posts SET status='rejected' WHERE id=$1`, [postId])
    await answerCallbackQuery(callbackId, '❌ Rejected')
    if (message?.message_id && ADMIN_GROUP) {
      await editMessageCaption(ADMIN_GROUP, message.message_id,
        `❌ <b>Rejected</b> — ${post.character_name}\n\n${post.caption}`)
      await editMessageReplyMarkup(ADMIN_GROUP, message.message_id, { inline_keyboard: [] })
    }
    return NextResponse.json({ ok: true })
  }

  // Approve
  await query(`UPDATE scheduled_posts SET status='approved' WHERE id=$1`, [postId])
  await answerCallbackQuery(callbackId, '✅ Approved!')

  if (message?.message_id && ADMIN_GROUP) {
    const scheduledDate = new Date(post.scheduled_at).toLocaleString('en-US', {
      dateStyle: 'medium', timeStyle: 'short',
    })
    await editMessageCaption(ADMIN_GROUP, message.message_id,
      `✅ <b>Approved</b> — ${post.character_name}\n🕐 Scheduled: ${scheduledDate}\n\n${post.caption}`)
    await editMessageReplyMarkup(ADMIN_GROUP, message.message_id, { inline_keyboard: [] })
  }

  // Publish immediately if scheduled time has already passed
  if (new Date(post.scheduled_at) <= new Date()) {
    await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/publish/now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId }),
    })
  } else {
    if (ADMIN_GROUP) {
      const scheduledDate = new Date(post.scheduled_at).toLocaleString('en-US', {
        dateStyle: 'medium', timeStyle: 'short',
      })
      await sendText(ADMIN_GROUP, `✅ <b>${post.character_name}</b> approved — will publish at ${scheduledDate}`)
    }
  }

  return NextResponse.json({ ok: true })
}
