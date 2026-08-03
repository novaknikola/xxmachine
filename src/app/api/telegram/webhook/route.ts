import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import {
  answerCallbackQuery,
  batchKeyboard,
  editMessageCaption,
  editMessageReplyMarkup,
  editMessageText,
  sendText,
} from '@/lib/telegram'
import { enqueueReelUrlsForUser, EnqueueUrlsError } from '@/lib/monitor/enqueue-from-urls'
import {
  addUrlsToBatch,
  findUserByChat,
  getBatch,
  markBatch,
  openBatch,
  setPromptMessage,
  startBatchWithPhoto,
} from '@/lib/monitor/telegram-batch'
import { estimateCopyPasteCost, formatUsd } from '@/lib/monitor/cost-estimate'

const CRON_SECRET = process.env.CRON_SECRET

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The summary the Replicate button sits on.
 *
 * The estimate is deliberately on the button's own message: Telegram makes it
 * far too easy to start an expensive job with a thumb, and a keyframe plus a
 * Seedance render per reel is real money. Duration is unknown until the reel is
 * probed, so this quotes the default-length case and says so.
 */
function batchSummary(urls: string[], hasReference: boolean): string {
  const per = estimateCopyPasteCost(null)
  const total = per.totalUsd * urls.length
  return [
    `🎬 <b>Copy-Paste batch</b>`,
    `Reels: <b>${urls.length}</b>`,
    hasReference ? 'Reference photo: ✅' : '⚠️ No reference photo yet — send one before starting.',
    '',
    `Estimated: <b>${formatUsd(total)}</b> (${formatUsd(per.totalUsd)} × ${urls.length}, at default clip length)`,
  ].join('\n')
}

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

    // ── Copy-Paste from chat: a reference photo, then reel links ───────────
    // Anything that is not /start or a button press used to be dropped here.
    if (message) {
      const chatId = message.chat?.id as number | undefined
      const userId = chatId != null ? await findUserByChat(chatId) : null

      if (chatId != null && !userId && (message.photo || message.text)) {
        await sendText(
          chatId,
          'This chat is not linked to an XXmachine account. Set your Telegram @username in Settings → Profile, then send /start.',
        )
        return NextResponse.json({ ok: true })
      }

      if (chatId != null && userId) {
        // A photo starts (or restarts) a batch. Telegram sends several sizes;
        // the last is the largest.
        const photo = message.photo as Array<{ file_id: string }> | undefined
        if (photo?.length) {
          try {
            const batch = await startBatchWithPhoto({
              userId, chatId, fileId: photo[photo.length - 1].file_id,
            })
            await sendText(
              chatId,
              `📌 Reference photo saved.\n\nNow send the Instagram reel links — one per line, up to 30. They can come in several messages.\n\n<code>batch ${batch.id.slice(0, 8)}</code>`,
            )
          } catch (err) {
            console.error('[telegram/webhook] photo failed:', err)
            await sendText(chatId, '❌ Could not save that photo. Try sending it again.')
          }
          return NextResponse.json({ ok: true })
        }

        const text = String(message.text ?? '')
        if (text && !text.startsWith('/')) {
          const result = await addUrlsToBatch({ userId, chatId, text })
          if (!result) {
            // Not links and not a command — say what the bot expects rather
            // than staying silent, which reads as broken.
            await sendText(
              chatId,
              'Send a reference photo, then Instagram reel links (one per line). /cancel drops the current batch.',
            )
            return NextResponse.json({ ok: true })
          }

          const { batch, added, duplicates, invalid, atCap } = result
          const notes = [
            added ? `Added ${added}` : 'Nothing new added',
            duplicates ? `${duplicates} already in the batch` : '',
            invalid.length ? `${invalid.length} not a reel link` : '',
            atCap ? 'batch is at the 30 reel cap' : '',
          ].filter(Boolean).join(' · ')

          const sent = await sendText(
            chatId,
            `${notes}\n\n${batchSummary(batch.urls, !!batch.reference_image_url)}`,
          ) as { message_id?: number }

          // Buttons only once the batch can actually run.
          if (batch.urls.length && batch.reference_image_url) {
            const withButtons = await sendText(chatId, 'Ready when you are:') as { message_id?: number }
            await editMessageReplyMarkup(chatId, withButtons.message_id!, batchKeyboard(batch.id))
            if (withButtons.message_id) await setPromptMessage(batch.id, withButtons.message_id)
          } else if (sent?.message_id) {
            await setPromptMessage(batch.id, sent.message_id)
          }
          return NextResponse.json({ ok: true })
        }

        if (text.startsWith('/cancel')) {
          const open = await openBatch(chatId)
          if (open) await markBatch(open.id, 'cancelled')
          await sendText(chatId, open ? '🗑 Batch dropped.' : 'Nothing to cancel.')
          return NextResponse.json({ ok: true })
        }
      }
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

    // ── Copy-Paste batch buttons ──────────────────────────────────────────
    if (action === 'cpstart' || action === 'cpcancel') {
      const chatId = cbMessage?.chat?.id as number | undefined
      const batch = postId ? await getBatch(postId) : null

      if (!batch || batch.status !== 'collecting') {
        await answerCallbackQuery(callbackId, 'This batch was already handled')
        if (chatId && cbMessage?.message_id) {
          await editMessageReplyMarkup(chatId, cbMessage.message_id, {})
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'cpcancel') {
        await markBatch(batch.id, 'cancelled')
        await answerCallbackQuery(callbackId, 'Cancelled')
        if (chatId && cbMessage?.message_id) {
          await editMessageText(chatId, cbMessage.message_id, '🗑 Batch cancelled.')
        }
        return NextResponse.json({ ok: true })
      }

      // Marked before the work starts: the enqueue below takes long enough for
      // an impatient second tap, and each tap is a paid batch.
      await markBatch(batch.id, 'submitted')
      await answerCallbackQuery(callbackId, 'Starting…')
      if (chatId && cbMessage?.message_id) {
        await editMessageReplyMarkup(chatId, cbMessage.message_id, {})
        await editMessageText(chatId, cbMessage.message_id, '⏳ Resolving reels…')
      }

      try {
        const result = await enqueueReelUrlsForUser({
          userId: batch.user_id,
          rawText: batch.urls.join('\n'),
          referenceImageUrl: batch.reference_image_url,
          // Nobody is going to press Replicate for a chat, and the message
          // below promises a finished video.
          autoReplicate: true,
          onReplicateQueued: async ({ jobId, classified, failed }) => {
            if (!chatId) return
            await sendText(
              chatId,
              jobId
                ? `🎬 Replicating ${classified} reel${classified === 1 ? '' : 's'}${failed ? ` · ${failed} could not be analysed` : ''}.`
                : `⚠️ Analysis finished but nothing could be replicated${failed ? ` — ${failed} failed to analyse` : ''}.`,
            ).catch(() => { /* the chat may have been closed */ })
          },
        })
        if (chatId && cbMessage?.message_id) {
          const failed = result.resolveErrors.length
          await editMessageText(
            chatId,
            cbMessage.message_id,
            [
              `✅ <b>Queued ${result.enqueued} reel${result.enqueued === 1 ? '' : 's'}</b>`,
              failed ? `${failed} could not be resolved and were skipped.` : '',
              '',
              'You will get the Drive folder here when it finishes.',
            ].filter(Boolean).join('\n'),
          )
        }
      } catch (err) {
        const msg = err instanceof EnqueueUrlsError ? err.message : 'Enqueue failed'
        console.error('[telegram/webhook] cpstart failed:', err)
        // Back to collecting so the same batch can be retried rather than
        // rebuilt from scratch.
        await markBatch(batch.id, 'collecting')
        if (chatId && cbMessage?.message_id) {
          await editMessageText(chatId, cbMessage.message_id, `❌ ${escapeHtml(msg)}`)
          await editMessageReplyMarkup(chatId, cbMessage.message_id, batchKeyboard(batch.id))
        }
      }
      return NextResponse.json({ ok: true })
    }

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