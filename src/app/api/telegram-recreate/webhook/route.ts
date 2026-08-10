import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import {
  sendText, sendPhoto, answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  recreateMenuKeyboard, characterPickerKeyboard, confirmKeyboard,
  FORMAT_CODES, FORMAT_LABELS, type FormatCode,
} from '@/lib/telegram-recreate'
import { renderPoseRecreatePrompt } from '@/lib/pose-recreate'
import { suggestedDimensionForFormat } from '@/lib/drive-archive/content-format'
import type { CopyPromptsJobInput } from '@/app/api/queue/submit/route'

/**
 * Webhook for the pose-recreate bot (@contentreplicatorbot). Deliberately a
 * standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id) — the existing Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Submits into the EXISTING copy_prompts_generate job type unchanged (same
 * mechanism Prompt Library / Pinterest pins already use: item 1 image is the
 * scene/pose reference, the job-level referenceImageUrls are the identity) —
 * no new job type, no edit to queue/process/[id]/route.ts.
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

/**
 * Fire-and-forget from the callback handler — Telegram gets its 200 back
 * immediately, this keeps running in the background (same process, pm2-hosted,
 * not serverless) and pushes the result whenever the job actually finishes.
 * Seedream Edit measured ~50s in testing; capped at 40×5s = ~3.3min.
 */
async function pollAndDeliver(jobId: string, chatId: number, characterName: string): Promise<void> {
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
          await sendPhoto(chatId, url, `✅ ${escapeHtml(characterName)}`).catch(() => {})
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

export async function POST(req: NextRequest) {
  if (!CRON_SECRET) {
    console.error('[telegram-recreate/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  const got = req.nextUrl.searchParams.get('secret')
  if (got !== CRON_SECRET) {
    console.error(
      `[telegram-recreate/webhook] secret mismatch — got len=${got?.length ?? 0} prefix=${got?.slice(0, 6)} ` +
      `expected len=${CRON_SECRET.length} prefix=${CRON_SECRET.slice(0, 6)} rawUrl=${req.nextUrl.pathname}${req.nextUrl.search}`,
    )
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
      await sendText(chatId, '🎭 <b>Recreate</b>\nPick a format:', recreateMenuKeyboard())
      return NextResponse.json({ ok: true })
    }

    // ── callback_query — fmt → character → confirm → go ──
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
        await answerCallbackQuery(cb.id, 'Cancelled')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        return NextResponse.json({ ok: true })
      }

      if (action === 'fmt') {
        const fmt = parts[2] as FormatCode
        await answerCallbackQuery(cb.id)
        const chars = await rows<{ id: string; name: string }>(
          `SELECT id, name FROM characters
            WHERE user_id = $1 AND array_length(face_ref_urls, 1) > 0
            ORDER BY name`,
          [userId],
        )
        if (!chars.length) {
          if (messageId) {
            await editMessageText(chatId, messageId, '⚠️ No character with reference photos yet — add face_ref_urls to a character first.')
          }
          return NextResponse.json({ ok: true })
        }
        if (messageId) {
          await editMessageText(chatId, messageId, `${FORMAT_LABELS[fmt]}\nPick a character:`)
          await editMessageReplyMarkup(chatId, messageId, characterPickerKeyboard(fmt, chars))
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'char') {
        const fmt = parts[2] as FormatCode
        const characterId = parts[3]
        await answerCallbackQuery(cb.id)
        const character = await one<{ name: string }>(
          `SELECT name FROM characters WHERE id = $1 AND user_id = $2`,
          [characterId, userId],
        )
        if (!character) {
          if (messageId) await editMessageText(chatId, messageId, '⚠️ Character not found.')
          return NextResponse.json({ ok: true })
        }
        if (messageId) {
          await editMessageText(chatId, messageId, `${FORMAT_LABELS[fmt]} — ${escapeHtml(character.name)}\nGenerate now?`)
          await editMessageReplyMarkup(chatId, messageId, confirmKeyboard(fmt, characterId))
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'go') {
        const fmt = parts[2] as FormatCode
        const characterId = parts[3]
        const character = await one<{ name: string; face_ref_urls: string[] }>(
          `SELECT name, face_ref_urls FROM characters WHERE id = $1 AND user_id = $2`,
          [characterId, userId],
        )
        if (!character?.face_ref_urls?.length) {
          await answerCallbackQuery(cb.id, 'Character has no reference photos')
          return NextResponse.json({ ok: true })
        }

        const contentFormat = FORMAT_CODES[fmt]
        const nsfw = fmt === 'fn'
        const wantCount = fmt === 'c' ? 4 : 1

        const poses = await rows<{ id: string; image_url: string; category: string | null }>(
          `SELECT id, image_url, category FROM pose_library
            WHERE user_id = $1 AND active = true AND nsfw = $2
            ORDER BY used_count ASC, random() LIMIT $3`,
          [userId, nsfw, wantCount],
        )
        if (!poses.length) {
          await answerCallbackQuery(cb.id, `No ${nsfw ? 'NSFW' : 'SFW'} poses in the library yet`)
          return NextResponse.json({ ok: true })
        }

        await answerCallbackQuery(cb.id, 'Starting…')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        await sendText(
          chatId,
          `🎨 Generating ${poses.length} image${poses.length === 1 ? '' : 's'} for <b>${escapeHtml(character.name)}</b>…`,
        )

        const items: CopyPromptsJobInput['items'] = poses.map(p => ({
          promptId: p.id,
          referenceImageUrls: [p.image_url],
          prompt: renderPoseRecreatePrompt({ category: p.category, nsfw }),
        }))

        const input: CopyPromptsJobInput = {
          items,
          mode: 'seedream-edit',
          referenceImageUrls: character.face_ref_urls,
          dimension: suggestedDimensionForFormat(contentFormat),
          folderName: character.name,
          contentFormat,
          characterId,
          characterName: character.name,
        }

        const row = await one<{ id: string }>(
          `INSERT INTO generation_queue (user_id, job_type, input, total_items)
           VALUES ($1, 'copy_prompts_generate', $2, $3)
           RETURNING id`,
          [userId, JSON.stringify(input), items.length],
        )
        if (!row) {
          await sendText(chatId, '❌ Could not queue the job.')
          return NextResponse.json({ ok: true })
        }

        await query(
          `UPDATE pose_library SET used_count = used_count + 1, last_used_at = now() WHERE id = ANY($1)`,
          [poses.map(p => p.id)],
        )

        // Start now instead of waiting for cron — same claim-then-kick pattern
        // the main Copy-Paste bot's cpgo handler uses.
        const claimed = await one<{ id: string }>(
          `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
            WHERE id=$1 AND status='pending' RETURNING id`,
          [row.id],
        ).catch(() => null)
        if (claimed) {
          fetch(`${internalBaseUrl()}/api/queue/process/${row.id}`, {
            method: 'POST',
            headers: { 'x-cron-secret': CRON_SECRET },
          }).catch(err => console.error('[telegram-recreate/webhook] fire worker:', err))
        }

        pollAndDeliver(row.id, chatId, character.name)
          .catch(err => console.error('[telegram-recreate/webhook] poll:', err))

        return NextResponse.json({ ok: true })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-recreate/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
