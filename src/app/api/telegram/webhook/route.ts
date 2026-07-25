import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import {
  answerCallbackQuery,
  editMessageCaption,
  editMessageReplyMarkup,
  sendText,
} from '@/lib/telegram'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  // Verify webhook secret — fail closed so an unset secret cannot open the webhook.
  if (!CRON_SECRET) {
    console.error('[telegram/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.nextUrl.searchParams.get('secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()

    // ── /start — link Telegram chat to XXmachine user ─────────
    const message = body.message
    if (message?.text?.startsWith('/start')) {
      const chatId = message.chat?.id as number | undefined
      const tgUsername = message.from?.username as string | undefined

      if (chatId) {
        let linked = false
        if (tgUsername) {
          const r = await query(
            `UPDATE users
                SET telegram_chat_id = $1
              WHERE lower(replace(coalesce(telegram, ''), '@', '')) = lower($2)
              RETURNING id`,
            [chatId, tgUsername],
          )
          linked = (r.rowCount ?? 0) > 0
        }

        const linkHint = linked
          ? 'Your account is linked — you will receive monitor alerts here.'
          : 'Set your Telegram @username in Settings → Profile, then send /start again to link alerts.'

        await sendText(
          chatId,
          `👋 <b>XXmachine Monitor Bot</b>\n\nChat ID: <code>${chatId}</code>\n${linkHint}\n\nAlerts: new IG posts, replication done/failed.`,
        )
      }
      return NextResponse.json({ ok: true })
    }

    const callbackQuery = body.callback_query

    if (!callbackQuery) {
      return NextResponse.json({ ok: true })
    }

    const callbackId = callbackQuery.id
    const data = callbackQuery.data as string | undefined
    const cbMessage = callbackQuery.message

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

      if (cbMessage?.chat?.id && cbMessage?.message_id) {
        await editMessageCaption(
          cbMessage.chat.id,
          cbMessage.message_id,
          `❌ Rejected\n\n${post.caption ?? ''}`,
        )
        await editMessageReplyMarkup(cbMessage.chat.id, cbMessage.message_id, {})
      }

      return NextResponse.json({ ok: true, status: 'rejected' })
    }

    await query(
      `UPDATE scheduled_posts SET status='approved', updated_at=NOW() WHERE id=$1`,
      [postId],
    )

    await answerCallbackQuery(callbackId, 'Approved')

    if (cbMessage?.chat?.id && cbMessage?.message_id) {
      await editMessageCaption(
        cbMessage.chat.id,
        cbMessage.message_id,
        `✅ Approved\n\n${post.caption ?? ''}`,
      )
      await editMessageReplyMarkup(cbMessage.chat.id, cbMessage.message_id, {})
    }

    return NextResponse.json({ ok: true, status: 'approved' })
  } catch (err) {
    console.error('[telegram/webhook]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}