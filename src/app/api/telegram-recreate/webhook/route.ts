import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import {
  sendText, answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  confirmRecreateKeyboard, settingsKeyboard,
} from '@/lib/telegram-recreate'
import { addUrlsToPending, attachPhotoFromTelegram, claimPending, clearPending, getPending, setAwaiting } from '@/lib/kling-recreate/pending'
import { enqueueKlingRecreateJobs } from '@/lib/kling-recreate/enqueue'
import { formatSettingsHtml, getKlingSettings, saveKlingSettings } from '@/lib/kling-recreate/settings'
import type { KlingUserSettings } from '@/lib/kling-recreate/types'
import type { KlingShotType, KlingVariant } from '@/lib/kling-recreate/kling-client'

/**
 * Webhook for @contentreplicatorbot — Kling 3.0 recreate pipeline.
 *
 * Standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id). The Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Flow: /start → send identity photo and/or IG reel URL(s) → confirm →
 * kling_recreate_v1 jobs. /settings and /ideas are the other commands.
 * Pose-recreate format/count/carousel UX and copy_prompts_generate
 * submission are gone from this bot.
 */
const CRON_SECRET = process.env.CRON_SECRET

const HELP = [
  '<b>Kling 3.0 Recreate</b>',
  'Send an Instagram reel URL and a reference photo of your character (or use the default photo from dashboard Settings).',
  'I scrape the reel, describe it at 1fps, build a character still, and animate it with Kling 3.0.',
  '',
  '/settings — variant, duration, sound, CFG, shot type, negative prompt',
  '/ideas — recent banked niche ideas (not rendered)',
  '/cancel — clear the current batch',
].join('\n')

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function findUserId(chatId: number): Promise<string | null> {
  const row = await one<{ id: string }>(
    `SELECT id FROM users WHERE telegram_recreate_chat_id = $1`,
    [chatId],
  )
  return row?.id ?? null
}

async function defaultReference(userId: string): Promise<string | null> {
  const row = await one<{ default_reference_image_url: string | null }>(
    `SELECT default_reference_image_url FROM users WHERE id = $1`,
    [userId],
  )
  return row?.default_reference_image_url ?? null
}

function batchStatusText(opts: {
  photoUrl: string | null
  defaultPhoto: boolean
  urls: string[]
}): string {
  const photo = opts.photoUrl
    ? '📸 Photo: attached'
    : opts.defaultPhoto
      ? '📸 Photo: using account default'
      : '📸 Photo: missing — send one, or set a default in dashboard Settings'
  return [
    '<b>Recreate batch</b>',
    photo,
    `🔗 Reels: ${opts.urls.length}`,
    opts.urls.length ? opts.urls.map(u => `• ${escapeHtml(u)}`).join('\n') : 'Paste Instagram reel URL(s).',
  ].join('\n')
}

async function showBatch(chatId: number, userId: string) {
  const pending = await getPending(chatId)
  const urls = pending?.urls ?? []
  const photoUrl = pending?.photo_url ?? null
  const hasDefault = !photoUrl && !!(await defaultReference(userId))
  const ready = urls.length > 0 && !!(photoUrl || hasDefault)
  await sendText(
    chatId,
    batchStatusText({ photoUrl, defaultPhoto: hasDefault, urls }),
    ready ? confirmRecreateKeyboard(urls.length) : undefined,
  )
}

export async function POST(req: NextRequest) {
  if (!CRON_SECRET) {
    console.error('[telegram-recreate/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.nextUrl.searchParams.get('secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const message = body.message
    const cb = body.callback_query

    if (message?.text?.startsWith('/start')) {
      const chatId = message.chat?.id as number | undefined
      const tgUsername = message.from?.username as string | undefined
      if (chatId) {
        let linked = false
        if (tgUsername) {
          const r = await query(
            `UPDATE users SET telegram_recreate_chat_id = $1
              WHERE lower(replace(coalesce(telegram, ''), '@', '')) = lower($2)
             RETURNING id`,
            [chatId, tgUsername],
          )
          linked = (r.rowCount ?? 0) > 0
        }
        await sendText(
          chatId,
          linked
            ? `✅ Linked.\n\n${HELP}`
            : '⚠️ Could not find your XXmachine account by Telegram username. Set your Telegram username in xxmachine Settings, then send /start again.',
        )
      }
      return NextResponse.json({ ok: true })
    }

    const chatId = (message?.chat?.id ?? cb?.message?.chat?.id) as number | undefined
    if (!chatId) return NextResponse.json({ ok: true })

    if (message?.text?.startsWith('/help')) {
      await sendText(chatId, HELP)
      return NextResponse.json({ ok: true })
    }

    const userId = await findUserId(chatId)
    if (!userId) {
      if (message || cb) {
        if (cb) await answerCallbackQuery(cb.id, 'Not linked — send /start first')
        else await sendText(chatId, '⚠️ Not linked yet — send /start first.')
      }
      return NextResponse.json({ ok: true })
    }

    if (message?.text?.startsWith('/cancel')) {
      await clearPending(chatId)
      await sendText(chatId, '✖️ Batch cleared.')
      return NextResponse.json({ ok: true })
    }

    if (message?.text?.startsWith('/settings')) {
      const settings = await getKlingSettings(userId)
      await sendText(chatId, formatSettingsHtml(settings), settingsKeyboard())
      return NextResponse.json({ ok: true })
    }

    if (message?.text?.startsWith('/ideas')) {
      const ideas = await rows<{ niche: string; prompt: string; created_at: string }>(
        `SELECT niche, prompt, created_at FROM kling_idea_bank
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`,
        [userId],
      )
      if (!ideas.length) {
        await sendText(chatId, 'No banked ideas yet — they appear while a reel is being analysed.')
        return NextResponse.json({ ok: true })
      }
      const lines = ideas.map((idea, i) =>
        `${i + 1}. <b>${escapeHtml(idea.niche)}</b>\n${escapeHtml(idea.prompt.slice(0, 400))}`,
      )
      await sendText(chatId, `<b>Recent ideas</b>\n\n${lines.join('\n\n')}`)
      return NextResponse.json({ ok: true })
    }

    if (message?.photo?.length) {
      const largest = message.photo[message.photo.length - 1]
      await attachPhotoFromTelegram({ chatId, userId, fileId: largest.file_id })
      await showBatch(chatId, userId)
      return NextResponse.json({ ok: true })
    }

    if (message?.text && !message.text.startsWith('/')) {
      const pending = await getPending(chatId)
      if (pending?.awaiting === 'negative_prompt') {
        await saveKlingSettings(userId, { negative_prompt: message.text })
        await setAwaiting(chatId, null)
        await sendText(chatId, formatSettingsHtml(await getKlingSettings(userId)), settingsKeyboard())
        return NextResponse.json({ ok: true })
      }
      if (pending?.awaiting === 'elements') {
        const ids = String(message.text).split(/[\s,]+/).map((token: string) => token.trim()).filter(Boolean).slice(0, 3)
        await saveKlingSettings(userId, { element_list: ids })
        await setAwaiting(chatId, null)
        await sendText(chatId, formatSettingsHtml(await getKlingSettings(userId)), settingsKeyboard())
        return NextResponse.json({ ok: true })
      }

      const added = await addUrlsToPending({ chatId, userId, text: message.text })
      if (!added) {
        await sendText(chatId, 'Paste Instagram reel URL(s), or send a reference photo.')
        return NextResponse.json({ ok: true })
      }
      const bits = [
        added.added ? `Added ${added.added}` : null,
        added.duplicates ? `${added.duplicates} duplicate${added.duplicates === 1 ? '' : 's'} skipped` : null,
        added.invalid.length ? `${added.invalid.length} invalid` : null,
        added.atCap ? 'batch is full (30)' : null,
      ].filter(Boolean)
      if (bits.length) await sendText(chatId, bits.join(' · '))
      await showBatch(chatId, userId)
      return NextResponse.json({ ok: true })
    }

    if (cb) {
      const data = String(cb.data ?? '')
      const messageId = cb.message?.message_id as number | undefined
      const parts = data.split(':')
      if (parts[0] !== 'kr') {
        await answerCallbackQuery(cb.id)
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'cancel') {
        await clearPending(chatId)
        await answerCallbackQuery(cb.id, 'Cancelled')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'go') {
        const open = await getPending(chatId)
        const urls = open?.urls ?? []
        const reference = open?.photo_url || await defaultReference(userId)
        if (!urls.length || !reference) {
          await answerCallbackQuery(cb.id, 'Need a photo and at least one reel URL')
          return NextResponse.json({ ok: true })
        }
        const pending = await claimPending(chatId)
        if (!pending) {
          await answerCallbackQuery(cb.id, 'Already queued')
          return NextResponse.json({ ok: true })
        }
        await answerCallbackQuery(cb.id, 'Queued…')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        const settings = await getKlingSettings(userId)
        const ids = await enqueueKlingRecreateJobs({
          userId, chatId, urls, referenceImageUrl: reference, settings,
        })
        await sendText(
          chatId,
          `🎬 Queued ${ids.length} Kling recreate job${ids.length === 1 ? '' : 's'}. I’ll send analysis, the character still, then the video.`,
        )
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'set') {
        const field = parts[2]
        const value = parts[3]
        const patch: Partial<KlingUserSettings> = {}
        if (field === 'variant' && (value === 'std' || value === 'pro' || value === '4k')) {
          patch.variant = value as KlingVariant
        } else if (field === 'dur') {
          if (value === 'auto') {
            patch.duration_mode = 'auto'
            patch.duration_sec = null
          } else {
            patch.duration_mode = 'fixed'
            patch.duration_sec = Number(value)
          }
        } else if (field === 'sound') {
          patch.sound = value === 'on'
        } else if (field === 'cfg') {
          patch.cfg_scale = Number(value)
        } else if (field === 'shot' && (value === 'customize' || value === 'intelligence')) {
          patch.shot_type = value as KlingShotType
        } else if (field === 'neg') {
          await setAwaiting(chatId, 'negative_prompt')
          await answerCallbackQuery(cb.id)
          await sendText(chatId, '✍️ Send the negative prompt as your next message.')
          return NextResponse.json({ ok: true })
        } else if (field === 'negclear') {
          patch.negative_prompt = null
        } else if (field === 'els') {
          await setAwaiting(chatId, 'elements')
          await answerCallbackQuery(cb.id)
          await sendText(chatId, '✍️ Send up to 3 Kling element IDs, comma-separated.')
          return NextResponse.json({ ok: true })
        } else if (field === 'elsclear') {
          patch.element_list = []
        }

        const next = await saveKlingSettings(userId, patch)
        await answerCallbackQuery(cb.id, 'Saved')
        if (messageId) {
          await editMessageText(chatId, messageId, formatSettingsHtml(next)).catch(() => {})
        }
        return NextResponse.json({ ok: true })
      }

      await answerCallbackQuery(cb.id)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-recreate/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
