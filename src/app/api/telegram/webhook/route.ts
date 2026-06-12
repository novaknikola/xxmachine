import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import {
  answerCallbackQuery,
  editMessageCaption,
  editMessageReplyMarkup,
} from '@/lib/telegram'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')

  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const callbackQuery = body.callback_query

    if (!callbackQuery) {
      return NextResponse.json({ ok: true })
    }

    const callbackId = callbackQuery.id
    const data = callbackQuery.data as string | undefined
    const message = callbackQuery.message

    if (!data) {
      await answerCallbackQuery(callbackId, 'Missing action')
      return NextResponse.json({ ok: true })
    }

    const [action, postId] = data.split(':')

    if (!postId || !['approve', 'reject'].includes(action)) {
      await answerCallbackQuery(callbackId, 'Unknown action')
      return NextResponse.json({ ok: true })
    }

    const post = await one<{
      id: string
      character_name: string
      image_url: string
      caption: string
      status: string
      scheduled_at: string
      platforms: string[]
    }>('SELECT * FROM scheduled_posts WHERE id=$1', [postId])

    if (!post || post.status !== 'pending_approval') {
      await answerCallbackQuery(callbackId, 'Post already processed')
      return NextResponse.json({ ok: true })
    }

    if (action === 'reject') {
      await query(
        `UPDATE scheduled_posts SET status='rejected', updated_at=NOW() WHERE id=$1`,
        [postId],
      )

      await answerCallbackQuery(callbackId, 'Rejected')

      if (message?.chat?.id && message?.message_id) {
        await editMessageCaption(
          message.chat.id,
          message.message_id,
          `❌ Rejected\n\n${post.caption ?? ''}`,
        )
        await editMessageReplyMarkup(message.chat.id, message.message_id, {})
      }

      return NextResponse.json({ ok: true, status: 'rejected' })
    }

    await query(
      `UPDATE scheduled_posts SET status='approved', updated_at=NOW() WHERE id=$1`,
      [postId],
    )

    await answerCallbackQuery(callbackId, 'Approved')

    if (message?.chat?.id && message?.message_id) {
      await editMessageCaption(
        message.chat.id,
        message.message_id,
        `✅ Approved\n\n${post.caption ?? ''}`,
      )
      await editMessageReplyMarkup(message.chat.id, message.message_id, {})
    }

    return NextResponse.json({ ok: true, status: 'approved' })
  } catch (err) {
    console.error('[telegram/webhook]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}