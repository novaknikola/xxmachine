import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { encryptOrNull } from '@/lib/crypto'
import {
  answerCallbackQuery,
  batchKeyboard,
  deleteMessage,
  editMessageCaption,
  editMessageReplyMarkup,
  editMessageText,
  mainMenuKeyboard,
  sendText,
} from '@/lib/telegram'
import { enqueueReelUrlsForUser, EnqueueUrlsError } from '@/lib/monitor/enqueue-from-urls'
import {
  addUrlsToBatch,
  findUserByChat,
  getBatch,
  markBatch,
  openBatch,
  setAwaitingPrompt,
  setCustomPrompt,
  setPromptMessage,
  startBatchWithPhoto,
} from '@/lib/monitor/telegram-batch'
import { estimateCopyPasteCost, formatUsd } from '@/lib/monitor/cost-estimate'
import {
  endFrameKeyboard,
  endFrameSummary,
  getRepurposeSettings,
  setEndFrameMode,
  setVariantCount,
  setOutputFolder,
  settingsKeyboard,
  settingsSummary,
  toggleEffect,
  type EndFrameMode,
} from '@/lib/monitor/telegram-repurpose'
import {
  enqueueRepurposeFromDriveFolder,
  enqueueRepurposeJob,
  parseDriveFolderId,
} from '@/lib/repurpose/enqueue-from-drive'
import { copyPasteArchiveLabel } from '@/lib/drive-archive/label'
import type { VideoEffectOpts } from '@/lib/video-ffmpeg'

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
 * probed, so this quotes the default-length case and says so. Repurpose/output/
 * prompt come from the account's saved /settings and the batch's own /prompt,
 * shown here so a tap on Replicate never surprises with settings picked up
 * silently in the background.
 */
function batchSummary(
  urls: string[],
  hasReference: boolean,
  settings: { repurposeCount: number; outputDriveFolderId: string | null; customPrompt: string | null },
): string {
  const per = estimateCopyPasteCost(null)
  const total = per.totalUsd * urls.length
  return [
    `🎬 <b>Copy-Paste batch</b>`,
    `Reels: <b>${urls.length}</b>`,
    hasReference ? 'Reference photo: ✅' : '⚠️ No reference photo yet — send one before starting.',
    settings.repurposeCount > 0
      ? `Repurpose: <b>${settings.repurposeCount}</b> variant${settings.repurposeCount === 1 ? '' : 's'} per video`
      : 'Repurpose: off (/settings to turn on)',
    settings.outputDriveFolderId ? `Output folder: <code>${escapeHtml(settings.outputDriveFolderId)}</code>` : '',
    settings.customPrompt ? `Extra prompt: “${escapeHtml(settings.customPrompt)}”` : '',
    '',
    `Estimated: <b>${formatUsd(total)}</b> (${formatUsd(per.totalUsd)} × ${urls.length}, at default clip length)`,
  ].filter(Boolean).join('\n')
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
        const rawText = String(message.text ?? '')

        // ── Text expected after the "WaveSpeed API key" menu button ──
        // Account-level, unlike awaiting_prompt (batch-scoped) — checked before
        // any command so a stray non-command message right after tapping the
        // button is never misread as reel links.
        if (rawText && !rawText.startsWith('/')) {
          const acct = await one<{ telegram_awaiting: string | null }>(
            `SELECT telegram_awaiting FROM users WHERE id = $1`, [userId],
          )
          if (acct?.telegram_awaiting === 'apikey') {
            const key = rawText.trim()
            await query(
              `INSERT INTO user_settings (user_id, wavespeed_api_key, updated_at)
               VALUES ($1, $2, now())
               ON CONFLICT (user_id) DO UPDATE SET wavespeed_api_key = $2, updated_at = now()`,
              [userId, encryptOrNull(key)],
            )
            await query(`UPDATE users SET telegram_awaiting = NULL WHERE id = $1`, [userId])
            if (message.message_id) await deleteMessage(chatId, message.message_id)
            await sendText(
              chatId,
              key
                ? '🔑 Saved. Your key was deleted from this chat and will be used for your own generations.'
                : '🔑 Cleared — your account will use the platform default key again.',
            )
            return NextResponse.json({ ok: true })
          }
        }

        // ── /menu — everything that is not a reel link ───────────────
        if (rawText.startsWith('/menu')) {
          const sent = await sendText(chatId, '📋 <b>XXmachine Bot Menu</b>\n\nPick one:') as { message_id?: number }
          if (sent?.message_id) {
            await editMessageReplyMarkup(chatId, sent.message_id, mainMenuKeyboard())
          }
          return NextResponse.json({ ok: true })
        }

        // ── /settings — repurpose options the bot remembers ──────────
        if (rawText.startsWith('/settings')) {
          const s = await getRepurposeSettings(userId)
          const sent = await sendText(chatId, settingsSummary(s)) as { message_id?: number }
          if (sent?.message_id) {
            await editMessageReplyMarkup(chatId, sent.message_id, settingsKeyboard(s))
          }
          return NextResponse.json({ ok: true })
        }

        // ── /output <link> — where repurpose variants are filed ──────
        if (rawText.startsWith('/output')) {
          const arg = rawText.slice('/output'.length).trim()
          if (!arg) {
            await setOutputFolder(userId, null)
            await sendText(chatId, '📁 Cleared — variants go to the dated archive folders again.')
            return NextResponse.json({ ok: true })
          }
          const id = parseDriveFolderId(arg)
          if (!id) {
            await sendText(chatId, '❌ That is not a Drive folder link. Send /output with no link to clear it.')
            return NextResponse.json({ ok: true })
          }
          await setOutputFolder(userId, id)
          await sendText(chatId, `📁 Variants will be filed in <code>${escapeHtml(id)}</code>.`)
          return NextResponse.json({ ok: true })
        }

        // ── /prompt <text> — appended to the rendered prompt for this batch ──
        // Scoped to the open batch, not the account: a per-run instruction
        // ("golden hour lighting") has no reason to survive past the batch
        // that requested it, unlike /settings and /output.
        if (rawText.startsWith('/prompt')) {
          const arg = rawText.slice('/prompt'.length).trim()
          const open = await openBatch(chatId)
          if (!open) {
            await sendText(chatId, 'No batch open yet — send a reference photo or reel links first.')
            return NextResponse.json({ ok: true })
          }
          await setCustomPrompt(open.id, arg)
          await setAwaitingPrompt(open.id, false)
          await sendText(
            chatId,
            arg
              ? `✍️ Added to every rendered prompt in this batch: “${escapeHtml(arg)}”`
              : '✍️ Cleared — nothing extra will be added to the rendered prompt.',
          )
          return NextResponse.json({ ok: true })
        }

        // ── Text expected after the "Add prompt" button, not reel links ──
        if (rawText && !rawText.startsWith('/')) {
          const open = await openBatch(chatId)
          if (open?.awaiting_prompt) {
            await setCustomPrompt(open.id, rawText)
            await setAwaitingPrompt(open.id, false)
            await sendText(
              chatId,
              rawText.trim()
                ? `✍️ Added to every rendered prompt in this batch: “${escapeHtml(rawText.trim())}”`
                : '✍️ Cleared — nothing extra will be added to the rendered prompt.',
            )
            return NextResponse.json({ ok: true })
          }
        }

        // ── Drive folder link — one repurpose job per video in it ────
        // Checked before the reel-link path: a Drive URL is not a reel link and
        // would otherwise fall through to "send a reference photo".
        const folderId = rawText && !rawText.startsWith('/')
          ? parseDriveFolderId(rawText)
          : null
        if (folderId) {
          const s = await getRepurposeSettings(userId)
          try {
            const { jobIds, videoNames } = await enqueueRepurposeFromDriveFolder({
              userId,
              folderId,
              count: s.variantCount,
              effects: s.effects,
              outputDriveFolderId: s.outputDriveFolderId,
            })
            const shown = videoNames.slice(0, 5).map(n => `• ${escapeHtml(n)}`).join('\n')
            await sendText(
              chatId,
              [
                `♻️ <b>${jobIds.length} repurpose job${jobIds.length === 1 ? '' : 's'} queued</b>`,
                `${s.variantCount} variants each — ${jobIds.length * s.variantCount} videos total.`,
                '',
                shown,
                videoNames.length > 5 ? `…and ${videoNames.length - 5} more` : '',
                '',
                'Change the count or effects with /settings.',
              ].filter(Boolean).join('\n'),
            )
          } catch (err) {
            await sendText(
              chatId,
              `❌ ${escapeHtml(err instanceof Error ? err.message : 'Could not queue that folder.')}`,
            )
          }
          return NextResponse.json({ ok: true })
        }

        // A photo starts (or restarts) a batch. Telegram sends several sizes;
        // the last is the largest.
        const photo = message.photo as Array<{ file_id: string }> | undefined
        if (photo?.length) {
          try {
            const { batch, replacedPrevious } = await startBatchWithPhoto({
              userId, chatId, fileId: photo[photo.length - 1].file_id,
            })
            const already = batch.urls.length
            await sendText(
              chatId,
              [
                '📌 Reference photo saved.',
                replacedPrevious ? 'Previous batch replaced.' : '',
                '',
                already
                  ? `${already} reel${already === 1 ? '' : 's'} already in this batch — press Replicate below, or send more links.`
                  : 'Now send the Instagram reel links — one per line, up to 30. They can come in several messages.',
                '',
                `<code>batch ${batch.id.slice(0, 8)}</code>`,
              ].filter(l => l !== undefined).join('\n'),
            )
            // Links that arrived before the photo now have everything they
            // need, so the buttons appear without asking for them again.
            if (already) {
              const ready = await sendText(chatId, 'Ready when you are:') as { message_id?: number }
              if (ready?.message_id) {
                await editMessageReplyMarkup(chatId, ready.message_id, batchKeyboard(batch.id))
                await setPromptMessage(batch.id, ready.message_id)
              }
            }
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

          const repurposeSettings = await getRepurposeSettings(userId)
          const sent = await sendText(
            chatId,
            `${notes}\n\n${batchSummary(batch.urls, !!batch.reference_image_url, {
              repurposeCount: repurposeSettings.variantCount,
              outputDriveFolderId: repurposeSettings.outputDriveFolderId,
              customPrompt: batch.custom_prompt,
            })}`,
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

    // ── /settings buttons ─────────────────────────────────────────────────
    if (action === 'rscount' || action === 'rsfx' || action === 'rsfolder') {
      const chatId = cbMessage?.chat?.id as number | undefined
      const settingsUserId = chatId != null ? await findUserByChat(chatId) : null
      if (!chatId || !settingsUserId) {
        await answerCallbackQuery(callbackId, 'Chat not linked')
        return NextResponse.json({ ok: true })
      }

      if (action === 'rscount') {
        await setVariantCount(settingsUserId, Number(postId))
        await answerCallbackQuery(callbackId, `${postId} variants`)
      } else if (action === 'rsfx') {
        await toggleEffect(settingsUserId, postId as keyof VideoEffectOpts)
        await answerCallbackQuery(callbackId, 'Updated')
      } else {
        // One button, two meanings: clearing is the common case (you set a
        // folder for one batch and want the archive tree back), and setting one
        // needs a link, which a button cannot carry.
        const current = await getRepurposeSettings(settingsUserId)
        if (current.outputDriveFolderId) {
          await setOutputFolder(settingsUserId, null)
          await answerCallbackQuery(callbackId, 'Back to archive folders')
        } else {
          await answerCallbackQuery(callbackId, 'Send /output <drive link>')
          await sendText(
            chatId,
            'Send <code>/output</code> followed by a Drive folder link to file variants there instead of the dated archive folders.',
          )
        }
      }

      const next = await getRepurposeSettings(settingsUserId)
      if (cbMessage?.message_id) {
        await editMessageText(chatId, cbMessage.message_id, settingsSummary(next))
        await editMessageReplyMarkup(chatId, cbMessage.message_id, settingsKeyboard(next))
      }
      return NextResponse.json({ ok: true })
    }

    // ── Repurpose-after-Copy-Paste buttons ────────────────────────────────
    if (action === 'rpgo' || action === 'rpno') {
      const chatId = cbMessage?.chat?.id as number | undefined
      const rpUserId = chatId != null ? await findUserByChat(chatId) : null
      if (!chatId || !rpUserId) {
        await answerCallbackQuery(callbackId, 'Chat not linked')
        return NextResponse.json({ ok: true })
      }
      // Clear the buttons first either way, so a double tap cannot pay twice.
      if (cbMessage?.message_id) {
        await editMessageReplyMarkup(chatId, cbMessage.message_id, {})
      }
      if (action === 'rpno') {
        await answerCallbackQuery(callbackId, 'Skipped')
        return NextResponse.json({ ok: true })
      }

      const item = await one<{ kling_video_url: string | null; profile: string; content_id: string | null }>(
        `SELECT kling_video_url, profile, content_id FROM discovery_items WHERE id = $1 AND user_id = $2`,
        [postId, rpUserId],
      )
      if (!item?.kling_video_url) {
        await answerCallbackQuery(callbackId, 'No video on that item')
        return NextResponse.json({ ok: true })
      }

      const s = await getRepurposeSettings(rpUserId)
      await enqueueRepurposeJob({
        userId: rpUserId,
        videoUrl: item.kling_video_url,
        videoName: `copypaste_${String(postId).slice(0, 8)}.mp4`,
        count: s.variantCount,
        effects: s.effects,
        outputDriveFolderId: s.outputDriveFolderId,
        characterKey: item.profile,
        seriesLabel: copyPasteArchiveLabel(item.profile, item.content_id),
      })
      await answerCallbackQuery(callbackId, `Queued ${s.variantCount} variants`)
      await sendText(chatId, `♻️ ${s.variantCount} variants queued. /settings to change the count.`)
      return NextResponse.json({ ok: true })
    }

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
        const repurposeSettings = await getRepurposeSettings(batch.user_id)
        const result = await enqueueReelUrlsForUser({
          userId: batch.user_id,
          rawText: batch.urls.join('\n'),
          referenceImageUrl: batch.reference_image_url,
          // Nobody is going to press Replicate for a chat, and the message
          // below promises a finished video.
          autoReplicate: true,
          endFrame: repurposeSettings.endFrameMode,
          repurposeCount: repurposeSettings.variantCount,
          outputDriveFolderId: repurposeSettings.outputDriveFolderId,
          customPrompt: batch.custom_prompt,
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

    // ── Add prompt button — arms "next message is the prompt, not links" ──
    if (action === 'cpprompt') {
      const chatId = cbMessage?.chat?.id as number | undefined
      const batch = postId ? await getBatch(postId) : null

      if (!batch || batch.status !== 'collecting') {
        await answerCallbackQuery(callbackId, 'This batch was already handled')
        return NextResponse.json({ ok: true })
      }

      await setAwaitingPrompt(batch.id, true)
      await answerCallbackQuery(callbackId, 'Send the text')
      if (chatId) {
        await sendText(
          chatId,
          batch.custom_prompt
            ? `✍️ Send the new text to add to the prompt (replaces “${escapeHtml(batch.custom_prompt)}”), or send nothing to clear it.`
            : '✍️ Send the text to add to the end of the rendered prompt.',
        )
      }
      return NextResponse.json({ ok: true })
    }

    // ── /menu buttons ──────────────────────────────────────────────────────
    if (['msettings', 'moutput', 'mapikey', 'mendframe', 'mefset', 'mjobs', 'mhelp'].includes(action)) {
      const chatId = cbMessage?.chat?.id as number | undefined
      const menuUserId = chatId != null ? await findUserByChat(chatId) : null
      if (!chatId || !menuUserId) {
        await answerCallbackQuery(callbackId, 'Chat not linked')
        return NextResponse.json({ ok: true })
      }

      if (action === 'msettings') {
        const s = await getRepurposeSettings(menuUserId)
        await answerCallbackQuery(callbackId, '')
        const sent = await sendText(chatId, settingsSummary(s)) as { message_id?: number }
        if (sent?.message_id) await editMessageReplyMarkup(chatId, sent.message_id, settingsKeyboard(s))
        return NextResponse.json({ ok: true })
      }

      if (action === 'moutput') {
        const s = await getRepurposeSettings(menuUserId)
        await answerCallbackQuery(callbackId, '')
        await sendText(chatId, [
          '📁 <b>Output folder</b>',
          s.outputDriveFolderId
            ? `Current: <code>${escapeHtml(s.outputDriveFolderId)}</code>`
            : 'Current: dated archive folders (default)',
          '',
          'Send <code>/output &lt;drive folder link&gt;</code> to change it, or <code>/output</code> with nothing to clear it.',
        ].join('\n'))
        return NextResponse.json({ ok: true })
      }

      if (action === 'mapikey') {
        await query(`UPDATE users SET telegram_awaiting = 'apikey' WHERE id = $1`, [menuUserId])
        await answerCallbackQuery(callbackId, 'Send the key')
        await sendText(
          chatId,
          '🔑 Paste your WaveSpeed API key. I\'ll delete your message right after saving it — nobody else will see it in this chat. Send nothing to go back to the platform default key.',
        )
        return NextResponse.json({ ok: true })
      }

      if (action === 'mendframe') {
        const s = await getRepurposeSettings(menuUserId)
        await answerCallbackQuery(callbackId, '')
        const sent = await sendText(chatId, endFrameSummary(s.endFrameMode)) as { message_id?: number }
        if (sent?.message_id) await editMessageReplyMarkup(chatId, sent.message_id, endFrameKeyboard(s.endFrameMode))
        return NextResponse.json({ ok: true })
      }

      if (action === 'mefset') {
        const mode = postId as EndFrameMode
        await setEndFrameMode(menuUserId, mode)
        await answerCallbackQuery(callbackId, `End frame: ${mode}`)
        if (cbMessage?.message_id) {
          await editMessageText(chatId, cbMessage.message_id, endFrameSummary(mode))
          await editMessageReplyMarkup(chatId, cbMessage.message_id, endFrameKeyboard(mode))
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'mjobs') {
        await answerCallbackQuery(callbackId, '')
        const jobs = await one<{ rows: Array<{
          job_type: string; status: string; done_items: number; total_items: number; created_at: string
        }> }>(
          `SELECT json_agg(t) AS rows FROM (
             SELECT job_type, status, done_items, total_items, created_at
               FROM generation_queue
              WHERE user_id = $1 AND job_type IN ('copy_paste_v2', 'copy_prompts_generate')
              ORDER BY created_at DESC LIMIT 5
           ) t`,
          [menuUserId],
        )
        const rows = jobs?.rows ?? []
        const icon = (s: string) => s === 'done' ? '✅' : s === 'failed' ? '❌' : s === 'processing' ? '⏳' : '•'
        await sendText(chatId, [
          '📊 <b>Recent jobs</b>',
          '',
          ...(rows.length
            ? rows.map(r => `${icon(r.status)} ${r.job_type} — ${r.status} (${r.done_items}/${r.total_items})`)
            : ['<i>Nothing yet.</i>']),
        ].join('\n'))
        return NextResponse.json({ ok: true })
      }

      if (action === 'mhelp') {
        await answerCallbackQuery(callbackId, '')
        await sendText(chatId, [
          '❓ <b>Commands</b>',
          '',
          '<b>/menu</b> — this menu',
          '<b>/settings</b> — repurpose variant count + effects',
          '<b>/output &lt;link&gt;</b> — Drive folder for repurpose variants',
          '<b>/prompt &lt;text&gt;</b> — appended to the current batch\'s rendered prompt',
          '<b>/cancel</b> — drop the batch you are assembling',
          '',
          'To replicate: send a reference photo, then reel links (one per line, up to 30) — same reference for all of them.',
        ].join('\n'))
        return NextResponse.json({ ok: true })
      }
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
    // Always ack with 200: a non-2xx makes Telegram retry the same update
    // repeatedly, which just re-triggers the same failure (e.g. replying to a
    // chat that blocked the bot) instead of resolving it.
    return NextResponse.json({ ok: false, error: String(err) })
  }
}