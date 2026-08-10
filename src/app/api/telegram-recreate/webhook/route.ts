import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import {
  sendText, sendPhoto, sendMediaGroup, answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  downloadTelegramFile, recreateMenuKeyboard, countKeyboard, promptChoiceKeyboard,
  FORMAT_CODES, FORMAT_LABELS, CAROUSEL_VARIANT_COUNT, type FormatCode,
} from '@/lib/telegram-recreate'
import { renderPoseRecreatePrompt } from '@/lib/pose-recreate'
import { suggestedDimensionForFormat, type ContentFormat } from '@/lib/drive-archive/content-format'
import { sanitizeDriveKey } from '@/lib/drive-archive/paths'
import { uploadBuffer } from '@/lib/supabase-storage'
import type { CopyPromptsJobInput } from '@/app/api/queue/submit/route'

/**
 * Webhook for the pose-recreate bot (@contentreplicatorbot). Deliberately a
 * standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id) — the existing Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Same UX principle as Copy-Paste v2 ("IGreplicator"): ad-hoc reference photo
 * + bulk count + optional extra prompt — see
 * [[project-xxmachine-copy-paste-v2]]. Submits into the EXISTING
 * copy_prompts_generate job type unchanged (item 1 image is the scene/pose
 * reference, the job-level referenceImageUrls are the identity) — no new job
 * type, no edit to queue/process/[id]/route.ts.
 *
 * Flow: /recreate -> pick format -> send photo -> pick count -> skip/add
 * prompt -> generate. telegram_recreate_pending carries state between these
 * steps (chat_id keyed) since each is a separate Telegram update.
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

interface PendingRow {
  format: string
  photo_url: string | null
  count: number | null
  awaiting_prompt: boolean
}

async function getPending(chatId: number): Promise<PendingRow | null> {
  return one<PendingRow>(
    `SELECT format, photo_url, count, awaiting_prompt FROM telegram_recreate_pending WHERE chat_id = $1`,
    [chatId],
  )
}

async function clearPending(chatId: number): Promise<void> {
  await query(`DELETE FROM telegram_recreate_pending WHERE chat_id = $1`, [chatId])
}

/**
 * Same 'carousels' vs everything-else split archiveFolderPaths uses
 * internally (drive-archive/resolve-folder.ts) — duplicated here rather than
 * imported since that mapping isn't exported, and this is the only other
 * place that needs to know which drive_folders.kind a contentFormat lands
 * under to look the folder back up.
 */
function driveArchiveKind(contentFormat: ContentFormat): 'carousels' | 'stories' {
  return contentFormat === 'carousels' ? 'carousels' : 'stories'
}

/**
 * Drive archiving is async (a cron sweeps drive_exports), so the folder may
 * not exist the instant generation finishes — poll briefly, same tolerance
 * notifyReplicationDone documents ("a missing link is normal and simply
 * omitted") but with a few retries first since here it usually does show up
 * within seconds of a small batch finishing.
 */
async function findDriveFolderLink(userId: string, label: string, contentFormat: ContentFormat): Promise<string | null> {
  const kind = driveArchiveKind(contentFormat)
  const characterKey = sanitizeDriveKey(label)
  for (let i = 0; i < 6; i++) {
    const row = await one<{ folder_id: string }>(
      `SELECT folder_id FROM drive_folders
        WHERE user_id = $1 AND character_key = $2 AND kind = $3 AND date_key <> '_'
        ORDER BY date_key DESC LIMIT 1`,
      [userId, characterKey, kind],
    )
    if (row?.folder_id) return `https://drive.google.com/drive/folders/${row.folder_id}`
    await sleep(3000)
  }
  return null
}

/**
 * A single Seedream Edit call has its own 10-minute AbortSignal
 * (wavespeed.ts), so a healthy batch can legitimately go quiet for a while
 * mid-item — 12 minutes with zero movement in the heartbeat is past that
 * with margin, which is what actually happened to the job that prompted
 * this: 2/5 done, then genuinely nothing for 17+ minutes with no error ever
 * logged (a known pre-existing quirk: the internal "kick" fetch can hit
 * undici's ~5min HeadersTimeoutError while the job keeps running server-side
 * regardless — see /api/queue/submit's own logs for the same pattern on
 * other jobs). Distinguishing "still working" from "actually stuck" this way
 * beats both a short fixed cutoff (abandons slow-but-healthy jobs) and no
 * cutoff at all (a truly dead job would hang the user forever).
 */
const STALE_AFTER_MS = 12 * 60 * 1000
const POLL_INTERVAL_MS = 10_000
const HARD_CAP_MS = 45 * 60 * 1000

/**
 * Fire-and-forget — Telegram gets its 200 back immediately, this keeps
 * running in the background (same process, pm2-hosted, not serverless) and
 * pushes the result whenever the job actually finishes, stalls, or fails.
 */
async function pollAndDeliver(
  jobId: string,
  chatId: number,
  userId: string,
  label: string,
  contentFormat: ContentFormat,
): Promise<void> {
  const deadline = Date.now() + HARD_CAP_MS

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const row = await one<{
      status: string
      started_at: string
      output: { copyPromptsRows?: { images: string[] }[]; progressAt?: string } | null
      error: string | null
    }>(`SELECT status, started_at, output, error FROM generation_queue WHERE id = $1`, [jobId])
    if (!row) return

    if (row.status === 'done') {
      const images = (row.output?.copyPromptsRows ?? []).flatMap(r => r.images ?? [])
      if (images.length === 1) {
        await sendPhoto(chatId, images[0], `✅ ${escapeHtml(label)}`).catch(() => {})
      } else if (images.length > 1) {
        // Telegram's sendMediaGroup caps at 10 items per call.
        for (let g = 0; g < images.length; g += 10) {
          await sendMediaGroup(chatId, images.slice(g, g + 10), `✅ ${escapeHtml(label)} (${images.length})`).catch(() => {})
        }
      } else {
        await sendText(chatId, '⚠️ Job finished but produced no image.')
      }

      const folderUrl = await findDriveFolderLink(userId, label, contentFormat).catch(() => null)
      if (folderUrl) await sendText(chatId, `📁 <a href="${folderUrl}">Drive folder</a>`)
      return
    }

    if (row.status === 'failed') {
      await sendText(chatId, `❌ Generation failed: ${escapeHtml((row.error ?? 'unknown error').slice(0, 300))}`)
      return
    }

    // Still processing/pending — only give up if the heartbeat has gone
    // stale, not just because time has passed.
    const lastActivity = row.output?.progressAt ? new Date(row.output.progressAt).getTime() : new Date(row.started_at).getTime()
    if (Date.now() - lastActivity > STALE_AFTER_MS) {
      const cancelled = await query(
        `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2 AND status='processing'`,
        [`Auto-cancelled — no progress for ${Math.round(STALE_AFTER_MS / 60000)}+ minutes`, jobId],
      )
      if ((cancelled.rowCount ?? 0) > 0) {
        await sendText(chatId, '❌ Generation stalled with no progress — cancelled automatically. Try again.')
        return
      }
      // Someone/something else already moved it past 'processing' between our
      // read and this UPDATE — fall through and let the next loop iteration
      // see whatever it actually became (done/failed).
    }
  }
  await sendText(chatId, '⏳ Still running after 45 minutes — check back later, it will land here if it finishes.')
}

/** Runs once format + photo + count (+ optional extra prompt) are all known. */
async function generateFromReference(opts: {
  userId: string
  chatId: number
  fmt: FormatCode
  referenceImageUrl: string
  wantCount: number
  extra: string | null
}): Promise<void> {
  const { userId, chatId, fmt, referenceImageUrl, wantCount, extra } = opts
  const contentFormat = FORMAT_CODES[fmt]
  const nsfw = fmt === 'fn'

  const poses = await rows<{ id: string; image_url: string; category: string | null }>(
    // Pure random, not least-used-first -- used_count is bumped on every
    // attempt (including stalled ones), and with a library sized in the tens
    // that made selection an effectively sequential walk through the pool,
    // so two characters generated back-to-back drew disjoint runs of the
    // same order instead of independently random picks.
    `SELECT id, image_url, category FROM pose_library
      WHERE user_id = $1 AND active = true AND content_format = $2 AND nsfw = $3
      ORDER BY random() LIMIT $4`,
    [userId, contentFormat, nsfw, wantCount],
  )
  if (!poses.length) {
    await sendText(chatId, `⚠️ No poses in the <b>${escapeHtml(FORMAT_LABELS[fmt])}</b> library yet — import some first.`)
    return
  }

  const label = `adhoc-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
  const note = poses.length < wantCount ? ` (only ${poses.length} pose${poses.length === 1 ? '' : 's'} available)` : ''
  // Carousel: each pose also earns CAROUSEL_VARIANT_COUNT extra angle/crop
  // slides via copy_prompts_generate's own carousel.enabled mechanism (the
  // same resolveCarouselVariantPrompts path bulk_carousel uses) — so the
  // real slide count is higher than the pose count for this format.
  const isCarousel = contentFormat === 'carousels'
  const totalSlides = poses.length * (isCarousel ? 1 + CAROUSEL_VARIANT_COUNT : 1)
  await sendText(chatId, `🎨 Generating ${totalSlides} image${totalSlides === 1 ? '' : 's'} from ${poses.length} pose${poses.length === 1 ? '' : 's'}${note}…`)

  const items: CopyPromptsJobInput['items'] = poses.map(p => ({
    promptId: p.id,
    referenceImageUrls: [p.image_url],
    prompt: renderPoseRecreatePrompt({ category: p.category, nsfw, extra }),
  }))

  const input: CopyPromptsJobInput = {
    items,
    mode: 'seedream-edit',
    referenceImageUrls: [referenceImageUrl],
    dimension: suggestedDimensionForFormat(contentFormat),
    folderName: label,
    contentFormat,
    ...(isCarousel ? { carousel: { enabled: true, count: CAROUSEL_VARIANT_COUNT as 1 | 2 | 3 | 4 } } : {}),
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

  pollAndDeliver(row.id, chatId, userId, label, contentFormat).catch(err => console.error('[telegram-recreate/webhook] poll:', err))
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

      const pending = await getPending(chatId)
      if (!pending) {
        await sendText(chatId, 'Send /recreate first, pick a format, then send the photo.')
        return NextResponse.json({ ok: true })
      }

      try {
        const largest = message.photo[message.photo.length - 1]
        const { buffer, contentType, extension } = await downloadTelegramFile(largest.file_id)
        const path = `pose-recreate-refs/${userId}/${Date.now()}.${extension}`
        const referenceImageUrl = await uploadBuffer(buffer, path, contentType)
        await query(
          `UPDATE telegram_recreate_pending SET photo_url = $1 WHERE chat_id = $2`,
          [referenceImageUrl, chatId],
        )
        const slidesPerPose = pending.format === 'c' ? 1 + CAROUSEL_VARIANT_COUNT : 1
        await sendText(chatId, 'How many to generate?', countKeyboard(slidesPerPose))
      } catch (err) {
        console.error('[telegram-recreate/webhook] reference upload failed:', err)
        await sendText(chatId, '❌ Could not process that photo — try again.')
      }
      return NextResponse.json({ ok: true })
    }

    // ── plain text reply — only meaningful while awaiting an extra prompt ──
    if (message?.text && !message.text.startsWith('/')) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const pending = await getPending(chatId)
      if (pending?.awaiting_prompt && pending.photo_url && pending.count) {
        const fmt = pending.format as FormatCode
        const photoUrl = pending.photo_url
        const wantCount = pending.count
        await clearPending(chatId)
        await generateFromReference({
          userId: (await findUserId(chatId))!,
          chatId,
          fmt,
          referenceImageUrl: photoUrl,
          wantCount,
          extra: message.text as string,
        })
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
           ON CONFLICT (chat_id) DO UPDATE SET format = $2, photo_url = NULL, count = NULL, awaiting_prompt = false, created_at = now()`,
          [chatId, fmt],
        )
        if (messageId) {
          await editMessageText(chatId, messageId, `${FORMAT_LABELS[fmt]}\n📸 Send a reference photo of your character now.`)
          await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✖️ Cancel', callback_data: 'rc:cancel' }]] })
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'cnt') {
        const n = parseInt(parts[2], 10)
        const pending = await getPending(chatId)
        if (!pending?.photo_url || !Number.isFinite(n)) {
          await answerCallbackQuery(cb.id, 'Send /recreate again')
          return NextResponse.json({ ok: true })
        }
        await query(`UPDATE telegram_recreate_pending SET count = $1 WHERE chat_id = $2`, [n, chatId])
        await answerCallbackQuery(cb.id)
        if (messageId) {
          await editMessageText(chatId, messageId, `${n}×. Want to add anything to the prompt? (style, wardrobe, anything extra)`)
          await editMessageReplyMarkup(chatId, messageId, promptChoiceKeyboard())
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'pskip' || action === 'padd') {
        const pending = await getPending(chatId)
        if (!pending?.photo_url || !pending.count) {
          await answerCallbackQuery(cb.id, 'Send /recreate again')
          return NextResponse.json({ ok: true })
        }

        if (action === 'padd') {
          await query(`UPDATE telegram_recreate_pending SET awaiting_prompt = true WHERE chat_id = $1`, [chatId])
          await answerCallbackQuery(cb.id)
          if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
          await sendText(chatId, '✍️ Type the extra prompt text now.')
          return NextResponse.json({ ok: true })
        }

        // pskip
        const fmt = pending.format as FormatCode
        const photoUrl = pending.photo_url
        const wantCount = pending.count
        await clearPending(chatId)
        await answerCallbackQuery(cb.id, 'Starting…')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        await generateFromReference({ userId, chatId, fmt, referenceImageUrl: photoUrl, wantCount, extra: null })
        return NextResponse.json({ ok: true })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-recreate/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
