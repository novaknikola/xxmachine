import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import {
  sendText, sendPhoto, answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  downloadTelegramFile, recreateMenuKeyboard,
  FORMAT_CODES, FORMAT_LABELS, type FormatCode,
} from '@/lib/telegram-recreate'
import { renderPoseRecreatePrompt } from '@/lib/pose-recreate'
import { suggestedDimensionForFormat } from '@/lib/drive-archive/content-format'
import { uploadBuffer } from '@/lib/supabase-storage'
import type { CopyPromptsJobInput } from '@/app/api/queue/submit/route'

/**
 * Webhook for the pose-recreate bot (@contentreplicatorbot). Deliberately a
 * standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id) — the existing Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Same UX principle as Copy-Paste v2 ("IGreplicator"): you send an ad-hoc
 * reference photo, not pick a saved character — see
 * [[project-xxmachine-copy-paste-v2]]. Submits into the EXISTING
 * copy_prompts_generate job type unchanged (item 1 image is the scene/pose
 * reference, the job-level referenceImageUrls are the identity) — no new job
 * type, no edit to queue/process/[id]/route.ts.
 */
const CRON_SECRET = process.env.CRON_SECRET

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function findUserId(chatId: number): Promise<string | null> {
  const row = await one<{ id: string }>(
    `SELECT id FROM users WHERE telegram_recreate_chat_id = $1`,
    [chatId],
  )
  return row?.id ?? null
}

async function clearPending(chatId: number): Promise<void> {
  await query(`DELETE FROM telegram_recreate_pending WHERE chat_id = $1`, [chatId])
}

/**
 * Fire-and-forget — Telegram gets its 200 back immediately, this keeps
 * running in the background (same process, pm2-hosted, not serverless) and
 * pushes the result whenever the job actually finishes. Seedream Edit
 * measured ~50s in testing; capped at 40×5s = ~3.3min.
 */
async function pollAndDeliver(jobId: string, chatId: number, label: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await sleep(5000)
    const row = await one<{
      status: string
      output: { copyPromptsRows?: { images: string[] }[] } | null
      error: string | null
    }>(`SELECT status, output, error FROM generation_queue WHERE id = $1`, [jobId])
    if (!row) return

    if (row.status === 'done') {
      const images = (row.output?.copyPromptsRows ?? []).flatMap(r => r.images ?? [])
      if (images.length) {
        for (const url of images) {
          await sendPhoto(chatId, url, `✅ ${escapeHtml(label)}`).catch(() => {})
        }
      } else {
        await sendText(chatId, '⚠️ Job finished but produced no image.')
      }
      return
    }
    if (row.status === 'failed') {
      await sendText(chatId, `❌ Generation failed: ${escapeHtml((row.error ?? 'unknown error').slice(0, 300))}`)
      return
    }
  }
  await sendText(chatId, '⏳ Still running after a few minutes — it will land here whenever it finishes.')
}

/** Runs after a reference photo lands for a chat with a pending format choice. */
async function generateFromReference(opts: {
  userId: string
  chatId: number
  fmt: FormatCode
  referenceImageUrl: string
}): Promise<void> {
  const { userId, chatId, fmt, referenceImageUrl } = opts
  const contentFormat = FORMAT_CODES[fmt]
  const nsfw = fmt === 'fn'
  const wantCount = fmt === 'c' ? 4 : 1

  const poses = await rows<{ id: string; image_url: string; category: string | null }>(
    `SELECT id, image_url, category FROM pose_library
      WHERE user_id = $1 AND active = true AND content_format = $2 AND nsfw = $3
      ORDER BY used_count ASC, random() LIMIT $4`,
    [userId, contentFormat, nsfw, wantCount],
  )
  if (!poses.length) {
    await sendText(chatId, `⚠️ No poses in the <b>${escapeHtml(FORMAT_LABELS[fmt])}</b> library yet — import some first.`)
    return
  }

  const label = `adhoc-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
  await sendText(chatId, `🎨 Generating ${poses.length} image${poses.length === 1 ? '' : 's'}…`)

  const items: CopyPromptsJobInput['items'] = poses.map(p => ({
    promptId: p.id,
    referenceImageUrls: [p.image_url],
    prompt: renderPoseRecreatePrompt({ category: p.category, nsfw }),
  }))

  const input: CopyPromptsJobInput = {
    items,
    mode: 'seedream-edit',
    referenceImageUrls: [referenceImageUrl],
    dimension: suggestedDimensionForFormat(contentFormat),
    folderName: label,
    contentFormat,
  }

  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'copy_prompts_generate', $2, $3)
     RETURNING id`,
    [userId, JSON.stringify(input), items.length],
  )
  if (!row) {
    await sendText(chatId, '❌ Could not queue the job.')
    return
  }

  await query(
    `UPDATE pose_library SET used_count = used_count + 1, last_used_at = now() WHERE id = ANY($1)`,
    [poses.map(p => p.id)],
  )

  // Start now instead of waiting for cron — same claim-then-kick pattern the
  // main Copy-Paste bot's cpgo handler uses.
  const claimed = await one<{ id: string }>(
    `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
      WHERE id=$1 AND status='pending' RETURNING id`,
    [row.id],
  ).catch(() => null)
  if (claimed && CRON_SECRET) {
    fetch(`${internalBaseUrl()}/api/queue/process/${row.id}`, {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }).catch(err => console.error('[telegram-recreate/webhook] fire worker:', err))
  }

  pollAndDeliver(row.id, chatId, label).catch(err => console.error('[telegram-recreate/webhook] poll:', err))
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

    // ── /start — link this bot's chat to an XXmachine account by Telegram username ──
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
            ? '✅ Linked. Send /recreate to start.'
            : '⚠️ Could not find your XXmachine account by Telegram username. Set your Telegram username in xxmachine Settings, then send /start again.',
        )
      }
      return NextResponse.json({ ok: true })
    }

    // ── /recreate — entry menu ──
    if (message?.text?.startsWith('/recreate')) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const userId = await findUserId(chatId)
      if (!userId) {
        await sendText(chatId, '⚠️ Not linked yet — send /start first.')
        return NextResponse.json({ ok: true })
      }
      await clearPending(chatId)
      await sendText(chatId, '🎭 <b>Recreate</b>\nPick a format:', recreateMenuKeyboard())
      return NextResponse.json({ ok: true })
    }

    // ── photo upload — reference image for a pending format choice ──
    if (message?.photo?.length) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const userId = await findUserId(chatId)
      if (!userId) return NextResponse.json({ ok: true })

      const pending = await one<{ format: string }>(
        `SELECT format FROM telegram_recreate_pending WHERE chat_id = $1`,
        [chatId],
      )
      if (!pending) {
        await sendText(chatId, 'Send /recreate first, pick a format, then send the photo.')
        return NextResponse.json({ ok: true })
      }
      const fmt = pending.format as FormatCode
      await clearPending(chatId)

      try {
        const largest = message.photo[message.photo.length - 1]
        const { buffer, contentType, extension } = await downloadTelegramFile(largest.file_id)
        const path = `pose-recreate-refs/${userId}/${Date.now()}.${extension}`
        const referenceImageUrl = await uploadBuffer(buffer, path, contentType)
        await generateFromReference({ userId, chatId, fmt, referenceImageUrl })
      } catch (err) {
        console.error('[telegram-recreate/webhook] reference upload failed:', err)
        await sendText(chatId, '❌ Could not process that photo — try again.')
      }
      return NextResponse.json({ ok: true })
    }

    // ── callback_query ──
    if (cb) {
      const data = cb.data as string | undefined
      const chatId = cb.message?.chat?.id as number | undefined
      const messageId = cb.message?.message_id as number | undefined
      if (!data || !chatId) return NextResponse.json({ ok: true })

      const userId = await findUserId(chatId)
      if (!userId) {
        await answerCallbackQuery(cb.id, 'Not linked — send /start first')
        return NextResponse.json({ ok: true })
      }

      const parts = data.split(':')
      const action = parts[0] === 'rc' ? parts[1] : null

      if (action === 'cancel') {
        await clearPending(chatId)
        await answerCallbackQuery(cb.id, 'Cancelled')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        return NextResponse.json({ ok: true })
      }

      if (action === 'fmt') {
        const fmt = parts[2] as FormatCode
        await answerCallbackQuery(cb.id)
        await query(
          `INSERT INTO telegram_recreate_pending (chat_id, format)
           VALUES ($1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET format = $2, created_at = now()`,
          [chatId, FORMAT_CODES[fmt]],
        )
        if (messageId) {
          await editMessageText(chatId, messageId, `${FORMAT_LABELS[fmt]}\n📸 Send a reference photo of your character now.`)
          await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✖️ Cancel', callback_data: 'rc:cancel' }]] })
        }
        return NextResponse.json({ ok: true })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-recreate/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
