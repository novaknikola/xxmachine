import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import {
  sendText, answerCallbackQuery, editMessageReplyMarkup,
  confirmRecreateKeyboard, stillPromptChoiceKeyboard, scriptOnlyKeyboard, bulkConfirmKeyboard,
  downloadTelegramVoice,
} from '@/lib/telegram-recreate'
import { transcribeVoiceNote } from '@/lib/grok'
import {
  addUrlsToPending, claimPending, claimPendingForScript, clearPending, getPending,
  holdPendingPhotoRole, resolvePendingPhotoRole, setAwaiting, setAwaitingVariation,
  setPendingCustomPrompt,
} from '@/lib/kling-recreate/pending'
import {
  enqueueKlingAction, enqueueKlingRecreateJobs, enqueueKlingScriptOnlyJob, enqueueKlingVariationJobs,
} from '@/lib/kling-recreate/enqueue'
import {
  isVariationAwaiting,
  parseVariationCallback,
  parseVariationRequest,
  planVariationCallback,
  variationAwaitingJobId,
} from '@/lib/kling-recreate/variation'
import {
  readBulkQueueRows, resolveDrivePhoto, writeBulkRowStatus, type BulkQueueRow,
} from '@/lib/kling-recreate/bulk-sheet'
import type { KlingRecreateJobRow } from '@/lib/kling-recreate/types'

/**
 * Webhook for @contentreplicatorbot — Seedance 2.5 recreate pipeline
 * (previously Kling 3.0; see D:\VScode\reels-analiza\docs\SEEDANCE-2.5-I2V.md
 * and the plan doc for the swap).
 *
 * Standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id). The Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Flow: /start → send identity photo and/or IG reel URL(s) → confirm →
 * kling_recreate_v1 jobs → still approval gate → dialogue-attribution gate
 * (new — confirm WHO says WHAT before the prompt is built) → prompt approval
 * gate → paid Seedance render. /ideas is the other command; /settings is
 * gone (Kling-only per-user options no longer exist).
 */
const CRON_SECRET = process.env.CRON_SECRET

const HELP = [
  '<b>Seedance 2.5 Recreate</b>',
  'Send an Instagram reel URL and a reference photo of your character (or use the default photo from dashboard Settings).',
  'I scrape the reel, describe it at ~2fps, build a character still, confirm the dialogue attribution with you, then animate it with Seedance 2.5.',
  '',
  'No reel? Send a photo + a written or spoken scene script instead (setting, action, dialogue) and I’ll generate the whole video from that alone.',
  'Every photo you send, I’ll ask what it represents — a character’s name/role, or "ambiance" if it’s just a style/setting reference, not a person. More than one real person in the scene? Just send each photo separately and answer that question each time.',
  '',
  '/bulk — prep rows in the "Kling Bulk Queue" sheet tab (Reel URL or Script, up to 3 character Drive photos + ambiance), then run this to queue up to 5 at once',
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

async function activeDialogueJob(userId: string, chatId: number): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    `SELECT id FROM kling_recreate_jobs
      WHERE user_id = $1 AND chat_id = $2 AND status = 'awaiting_dialogue_approval'
      ORDER BY updated_at DESC LIMIT 1`,
    [userId, chatId],
  )
}

/**
 * Resolves every Drive photo for one bulk-queue row (catches and reports a
 * failure for THIS row only — one bad/private Drive link must never block
 * the other rows in the same /bulk trigger), then enqueues it through the
 * exact same enqueueKlingRecreateJobs/enqueueKlingScriptOnlyJob path a
 * normal Telegram batch uses. Writes Job ID back immediately to claim the
 * row before moving to the next one.
 */
async function enqueueBulkRow(userId: string, chatId: number, row: BulkQueueRow): Promise<void> {
  try {
    const referencePhotos: Record<string, string> = {}
    for (const char of row.characters) {
      referencePhotos[char.name] = await resolveDrivePhoto(
        char.driveUrl,
        `kling-recreate-refs/${userId}/bulk-${row.rowNumber}-${encodeURIComponent(char.name)}-${Date.now()}.jpg`,
      )
    }
    const ambiancePhotoUrl = row.ambianceDriveUrl
      ? await resolveDrivePhoto(row.ambianceDriveUrl, `kling-recreate-refs/${userId}/bulk-${row.rowNumber}-ambiance-${Date.now()}.jpg`)
      : null
    const primaryUrl = Object.values(referencePhotos)[0]
    const sourceLabel = `Row ${row.rowNumber}`

    if (row.reelUrl) {
      const ids = await enqueueKlingRecreateJobs({
        userId, chatId, urls: [row.reelUrl], referenceImageUrl: primaryUrl,
        customPrompt: row.instruction, referencePhotos, ambiancePhotoUrl,
        sourceLabel, sheetRow: row.rowNumber,
      })
      await writeBulkRowStatus(row.rowNumber, { status: 'queued', jobId: ids[0] ?? '' })
    } else if (row.script) {
      const jobId = await enqueueKlingScriptOnlyJob({
        userId, chatId, referenceImageUrl: primaryUrl, script: row.script,
        referencePhotos, ambiancePhotoUrl, sourceLabel, sheetRow: row.rowNumber,
      })
      await writeBulkRowStatus(row.rowNumber, { status: 'queued', jobId })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[kling-recreate] bulk row ${row.rowNumber} failed:`, err)
    await writeBulkRowStatus(row.rowNumber, { status: 'failed', error: message.slice(0, 300) }).catch(() => {})
  }
}

function batchStatusText(opts: {
  photoUrl: string | null
  defaultPhoto: boolean
  urls: string[]
  customPrompt?: string | null
  namedPhotoNames?: string[]
  hasAmbiance?: boolean
}): string {
  const photo = opts.namedPhotoNames?.length
    ? `📸 Characters: ${opts.namedPhotoNames.map(n => escapeHtml(n)).join(', ')}`
    : opts.photoUrl
      ? '📸 Photo: attached'
      : opts.defaultPhoto
        ? '📸 Photo: using account default'
        : '📸 Photo: missing — send one, or set a default in dashboard Settings'
  const ambiance = opts.hasAmbiance ? '🖼️ Ambiance reference: attached' : null
  const script = opts.customPrompt?.trim()
    ? `📝 Script: ${escapeHtml(opts.customPrompt.trim().slice(0, 60))}${opts.customPrompt.trim().length > 60 ? '…' : ''}`
    : null
  const reelsLine = opts.urls.length
    ? opts.urls.map(u => `• ${escapeHtml(u)}`).join('\n')
    : script
      ? 'Paste Instagram reel URL(s), or generate from your script alone (below).'
      : 'Paste Instagram reel URL(s).'
  return [
    '<b>Recreate batch</b>',
    photo,
    ambiance,
    script,
    `🔗 Reels: ${opts.urls.length}`,
    reelsLine,
  ].filter(Boolean).join('\n')
}

/**
 * Once the batch has both a photo and >=1 URL, one optional question is
 * asked before the Confirm button appears — a custom still prompt.
 * custom_prompt uses '' (not null) as the "asked, declined" sentinel so this
 * doesn't re-ask on every later message in the same batch (e.g. adding one
 * more URL). The shot-mode question that used to sit here is gone — Seedance
 * has no per-shot re-anchoring image, so there is only ever one still now.
 */
async function showBatch(chatId: number, userId: string) {
  const pending = await getPending(chatId)
  const urls = pending?.urls ?? []
  const photoUrl = pending?.photo_url ?? null
  const namedPhotoNames = Object.keys(pending?.reference_photos ?? {})
  const hasDefault = !photoUrl && !namedPhotoNames.length && !!(await defaultReference(userId))
  const hasIdentity = !!(photoUrl || hasDefault || namedPhotoNames.length)
  const ready = urls.length > 0 && hasIdentity
  // No URL at all, but at least one identity photo + a real (non-empty,
  // non-skipped) script — offer the script-only path instead of just
  // repeating "paste a URL".
  const scriptOnlyReady = !ready && urls.length === 0 && hasIdentity && !!pending?.custom_prompt?.trim()

  if (ready && pending?.custom_prompt == null) {
    await sendText(
      chatId,
      '✍️ Add a specific instruction for the character still before it\'s generated? ' +
        '(wardrobe, pose tweak — and if more than one person is in the scene, say which role ' +
        'your photo plays, e.g. "the maid" or "the blonde woman on the left") — or skip.',
      stillPromptChoiceKeyboard(),
    )
    return
  }

  await sendText(
    chatId,
    batchStatusText({
      photoUrl, defaultPhoto: hasDefault, urls, customPrompt: pending?.custom_prompt, namedPhotoNames,
      hasAmbiance: !!pending?.ambiance_photo_url,
    }),
    ready ? confirmRecreateKeyboard(urls.length) : (scriptOnlyReady ? scriptOnlyKeyboard() : undefined),
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
      // /cancel only ever cleared the draft batch — a job already sitting at
      // an awaiting_*_approval gate (still/dialogue/prompt) kept living on
      // and kept intercepting every later plain-text message as if it were
      // a reply to THAT job (activeDialogueJob below has no time limit and
      // isn't scoped to "the current batch"). Confirmed live 2026-09-18: a
      // job left at awaiting_dialogue_approval silently hijacked new script/
      // URL text as a "dialogue correction" long after /cancel + /start.
      // Retire any such job for this chat too — no paid action fires from
      // this, it only stops it from intercepting anything further.
      const retired = await rows<{ sheet_row: number | null }>(
        `UPDATE kling_recreate_jobs SET status = 'failed', error = 'Cancelled by user', updated_at = now()
          WHERE chat_id = $1 AND status IN ('awaiting_still_approval', 'awaiting_dialogue_approval', 'awaiting_prompt_approval')
          RETURNING sheet_row`,
        [chatId],
      )
      if (retired.length) {
        const { writeBulkRowStatus } = await import('@/lib/kling-recreate/bulk-sheet')
        for (const r of retired) {
          if (r.sheet_row) await writeBulkRowStatus(r.sheet_row, { status: 'failed', error: 'Cancelled by user' }).catch(() => {})
        }
      }
      await sendText(
        chatId,
        retired.length > 0
          ? `✖️ Batch cleared, and ${retired.length} pending job(s) waiting on your approval were cancelled too.`
          : '✖️ Batch cleared.',
      )
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

    /**
     * Bulk trigger — read the "Kling Bulk Queue" sheet tab, show every
     * unclaimed row (a Reel URL or Script, plus at least one character
     * Drive photo, no Job ID yet) as a summary, and require one explicit
     * tap before anything fires (kr:bulkgo below) — the conscious spend
     * gate the user asked for instead of an automatic poller.
     */
    if (message?.text?.startsWith('/bulk')) {
      let bulkRows: BulkQueueRow[]
      try {
        bulkRows = await readBulkQueueRows()
      } catch (err) {
        console.error('[kling-recreate] bulk sheet read failed:', err)
        await sendText(chatId, '⚠️ Could not read the "Kling Bulk Queue" sheet tab — check it\'s shared with the service account and try again.')
        return NextResponse.json({ ok: true })
      }
      if (!bulkRows.length) {
        await sendText(
          chatId,
          'No new rows found in the "Kling Bulk Queue" sheet tab (need a Reel URL or Script, plus at least one character photo, and no Job ID yet).',
        )
        return NextResponse.json({ ok: true })
      }
      const lines = bulkRows.map(r => {
        const kind = r.reelUrl ? 'reel' : 'script'
        const names = r.characters.map(c => c.name).join(', ')
        return `Row ${r.rowNumber} (${kind}, ${names}${r.ambianceDriveUrl ? ' + ambiance' : ''})`
      })
      await sendText(
        chatId,
        `📋 Found ${bulkRows.length} row(s) ready:\n${lines.map(l => `• ${escapeHtml(l)}`).join('\n')}\n\nQueue all of them?`,
        bulkConfirmKeyboard(bulkRows.length),
      )
      return NextResponse.json({ ok: true })
    }

    /**
     * Every photo, without exception, is held and gets an explicit role
     * question — no caption shortcut, no "first photo is free" fast path
     * (2026-09-18, explicit user ask after 3 straight failed attempts at
     * trusting Telegram photo captions: an album/multi-select send doesn't
     * reliably attach a caption to every photo in it, so silently trusting
     * one when present just papered over an unreliable signal). This is
     * the ONLY place a photo is ever recorded now — nothing downstream is
     * allowed to assume a photo's role from anything sent earlier.
     */
    if (message?.photo?.length) {
      const pendingPhoto = await getPending(chatId)
      if (isVariationAwaiting(pendingPhoto?.awaiting)) {
        await sendText(
          chatId,
          'Send the change as one text message (and how many copies, 1–6). Example: <code>softer smile, 3</code>',
        )
        return NextResponse.json({ ok: true })
      }
      const largest = message.photo[message.photo.length - 1]
      await holdPendingPhotoRole({ chatId, userId, fileId: largest.file_id })
      await sendText(
        chatId,
        '🎭 Šta predstavlja ova fotografija? Otkucaj ime lika (npr. "Tiana"), ili napiši "ambijent" ' +
          'ako je ovo samo referenca za izgled/pozadinu scene.',
      )
      return NextResponse.json({ ok: true })
    }

    /**
     * A voice note has no other meaning in this bot (unlike text, which
     * could be reel URLs or a dialogue correction), so it always transcribes
     * via xAI STT and lands in custom_prompt — this is the "manual context"
     * input this session's user asked for (matching the Python idea-bank
     * pipeline's loose, dictated-along "Manuelna skripta" column, which is
     * supplied UP FRONT, not gated behind a button). Not gated on
     * pending?.awaiting === 'custom_prompt' — deliberately reverted that
     * gate (2026-09-18): a user who just sends a voice note without first
     * tapping "Add prompt" got silently ignored (confirmed live, no pending
     * row existed yet because they sent it before any URL/photo). Works at
     * any point in the batch, including before a photo/URL exists at all —
     * setPendingCustomPrompt upserts, same as holdPendingPhotoRole.
     */
    if (message?.voice) {
      try {
        const { buffer, mimeType, filename } = await downloadTelegramVoice(message.voice.file_id)
        const transcript = await transcribeVoiceNote(buffer, filename, mimeType)
        if (!transcript) {
          await sendText(chatId, "Couldn't make out any speech in that voice note — try again or type it instead.")
          return NextResponse.json({ ok: true })
        }
        await setPendingCustomPrompt(chatId, userId, transcript)
        await setAwaiting(chatId, null)
        await sendText(chatId, `🎙️ Got it, saved as manual context for the next recreate: <i>${escapeHtml(transcript)}</i>`)
        await showBatch(chatId, userId)
      } catch (err) {
        console.error('[kling-recreate] voice transcription failed:', err)
        await sendText(chatId, '⚠️ Could not transcribe that voice note — try again or type the instruction instead.')
      }
      return NextResponse.json({ ok: true })
    }

    if (message?.text && !message.text.startsWith('/')) {
      const pending = await getPending(chatId)

      if (pending?.awaiting === 'photo_role') {
        const resolved = await resolvePendingPhotoRole(chatId, userId, message.text)
        if (!resolved) {
          await setAwaiting(chatId, null)
          await sendText(chatId, 'That photo expired — send it again.')
          return NextResponse.json({ ok: true })
        }
        await sendText(
          chatId,
          resolved.kind === 'ambiance'
            ? '✅ Sačuvano kao ambient/scene reference.'
            : `✅ Sačuvano: ${escapeHtml(resolved.label)}`,
        )
        await showBatch(chatId, userId)
        return NextResponse.json({ ok: true })
      }

      if (isVariationAwaiting(pending?.awaiting)) {
        const parentId = variationAwaitingJobId(pending.awaiting)
        const parsed = parseVariationRequest(message.text)
        if (!parentId) {
          await setAwaiting(chatId, null)
          await sendText(chatId, 'That variation request expired — tap Change anything? on the video again.')
          return NextResponse.json({ ok: true })
        }
        if (!parsed.change) {
          await sendText(
            chatId,
            'I need the change text (and optionally a count 1–6). Try: <code>softer smile, 3</code>',
          )
          return NextResponse.json({ ok: true })
        }
        const parent = await one<KlingRecreateJobRow>(
          `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
          [parentId, userId],
        )
        if (!parent?.character_image_url) {
          await setAwaiting(chatId, null)
          await sendText(chatId, 'That job has no character still to vary — run the original recreate first.')
          return NextResponse.json({ ok: true })
        }
        await setAwaiting(chatId, null)
        const ids = await enqueueKlingVariationJobs({
          userId,
          chatId,
          parent,
          change: parsed.change,
          count: parsed.count,
        })
        await sendText(
          chatId,
          `🎬 Queued ${ids.length} variation${ids.length === 1 ? '' : 's'} — ` +
            `<i>${escapeHtml(parsed.change)}</i>. I’ll send each video when it’s ready.`,
        )
        return NextResponse.json({ ok: true })
      }
      if (pending?.awaiting === 'custom_prompt') {
        await setPendingCustomPrompt(chatId, userId, message.text)
        await setAwaiting(chatId, null)
        await showBatch(chatId, userId)
        return NextResponse.json({ ok: true })
      }

      if (pending?.awaiting === 'script_lead_character') {
        const leadCharacter = message.text.trim()
        const namedPhotos = pending.reference_photos ?? {}
        const reference = pending.photo_url || await defaultReference(userId) || Object.values(namedPhotos)[0]
        if (!leadCharacter || !pending.custom_prompt?.trim() || !reference) {
          await setAwaiting(chatId, null)
          await sendText(chatId, 'That script-only batch expired — tap "Generate from script" again.')
          return NextResponse.json({ ok: true })
        }
        const claimed = await claimPendingForScript(chatId)
        if (!claimed) {
          await sendText(chatId, 'Already queued.')
          return NextResponse.json({ ok: true })
        }
        await enqueueKlingScriptOnlyJob({
          userId, chatId, referenceImageUrl: reference,
          script: claimed.custom_prompt!, leadCharacter, referencePhotos: claimed.reference_photos,
          ambiancePhotoUrl: claimed.ambiance_photo_url,
        })
        await sendText(
          chatId,
          `🎬 Queued script-only recreate (${escapeHtml(leadCharacter)} = your photo). ` +
            `I’ll send the analysis, then the character still for approval, then a quick dialogue check, ` +
            `then the Seedance prompt for approval, then the video.`,
        )
        return NextResponse.json({ ok: true })
      }

      // A plain-text reply while a job is sitting at the dialogue-attribution
      // gate is a speaker correction, not a new batch of reel URLs — check
      // before falling through to addUrlsToPending.
      const dialogueJob = await activeDialogueJob(userId, chatId)
      if (dialogueJob) {
        await enqueueKlingAction({
          userId, chatId, jobId: dialogueJob.id,
          action: 'correct_dialogue', correction: message.text,
        })
        return NextResponse.json({ ok: true })
      }

      const added = await addUrlsToPending({ chatId, userId, text: message.text })
      if (!added) {
        // No reel URL(s) in this text at all — same fallback as a voice
        // note: treat it as manual context (the "Manuelna skripta" input)
        // rather than rejecting it, so it works whether typed or spoken,
        // at any point, without requiring "Add prompt" to be tapped first.
        await setPendingCustomPrompt(chatId, userId, message.text)
        await sendText(chatId, `📝 Saved as manual context for the next recreate: <i>${escapeHtml(message.text)}</i>`)
        await showBatch(chatId, userId)
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

      if (parts[1] === 'bulkgo') {
        await answerCallbackQuery(cb.id, 'Queuing…')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        let bulkRows: BulkQueueRow[]
        try {
          bulkRows = await readBulkQueueRows()
        } catch (err) {
          console.error('[kling-recreate] bulk sheet read failed:', err)
          await sendText(chatId, '⚠️ Could not re-read the sheet — try /bulk again.')
          return NextResponse.json({ ok: true })
        }
        if (!bulkRows.length) {
          await sendText(chatId, 'Those rows are gone now (already claimed or edited) — run /bulk again.')
          return NextResponse.json({ ok: true })
        }
        for (const row of bulkRows) {
          await enqueueBulkRow(userId, chatId, row)
        }
        await sendText(
          chatId,
          `🎬 Queued ${bulkRows.length} row${bulkRows.length === 1 ? '' : 's'} from the sheet. ` +
            `I’ll notify you here as each one needs still/dialogue/prompt approval — look for the "Row N —" prefix.`,
        )
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'scriptonly') {
        const open = await getPending(chatId)
        const namedPhotos = open?.reference_photos ?? {}
        // Already have named photos (one per captioned character) — nothing
        // left to ask, the names ARE the lead-character answer.
        if (Object.keys(namedPhotos).length) {
          const reference = open?.photo_url || await defaultReference(userId) || Object.values(namedPhotos)[0]
          if (!open?.custom_prompt?.trim() || !reference) {
            await answerCallbackQuery(cb.id, 'Need a photo and a script')
            return NextResponse.json({ ok: true })
          }
          const claimed = await claimPendingForScript(chatId)
          if (!claimed) {
            await answerCallbackQuery(cb.id, 'Already queued')
            return NextResponse.json({ ok: true })
          }
          await answerCallbackQuery(cb.id, 'Queued…')
          if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
          await enqueueKlingScriptOnlyJob({
            userId, chatId, referenceImageUrl: reference,
            script: claimed.custom_prompt!, referencePhotos: claimed.reference_photos,
            ambiancePhotoUrl: claimed.ambiance_photo_url,
          })
          await sendText(
            chatId,
            `🎬 Queued script-only recreate (${escapeHtml(Object.keys(namedPhotos).join(', '))}). ` +
              `I’ll send the analysis, then the character still for approval, then a quick dialogue check, ` +
              `then the Seedance prompt for approval, then the video.`,
          )
          return NextResponse.json({ ok: true })
        }
        await setAwaiting(chatId, 'script_lead_character')
        await answerCallbackQuery(cb.id)
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        await sendText(chatId, '🎭 Which character in your script is played by your reference photo? Just the name (e.g. Tiana).')
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'stillprompt') {
        if (parts[2] === 'add') {
          await setAwaiting(chatId, 'custom_prompt')
          await answerCallbackQuery(cb.id)
          if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
          await sendText(chatId, '✍️ Send the instruction as text, or 🎙️ a voice note — describe the scene/dialogue loosely, it just needs to be a rough guide.')
          return NextResponse.json({ ok: true })
        }
        // skip: '' (not null) marks the question as asked so showBatch never re-asks it.
        await setPendingCustomPrompt(chatId, userId, '')
        await answerCallbackQuery(cb.id, 'Skipped')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        await showBatch(chatId, userId)
        return NextResponse.json({ ok: true })
      }

      // ── Approval gates — still, then dialogue attribution, then prompt ──
      if (parts[1] === 'stillok' || parts[1] === 'stillrg' || parts[1] === 'dialogueok'
        || parts[1] === 'promptok' || parts[1] === 'promptrg') {
        const jobId = parts[2]
        const job = await one<KlingRecreateJobRow>(
          `SELECT id, status FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
          [jobId, userId],
        )
        if (!job) {
          await answerCallbackQuery(cb.id, 'Job not found')
          return NextResponse.json({ ok: true })
        }
        const action =
          parts[1] === 'stillok' ? 'approve_still' as const :
          parts[1] === 'stillrg' ? 'regenerate_still' as const :
          parts[1] === 'dialogueok' ? 'approve_dialogue' as const :
          parts[1] === 'promptok' ? 'approve_prompt' as const :
          'regenerate_prompt' as const
        // Clear the buttons first so a double-tap cannot queue (and pay for) twice.
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {}).catch(() => {})
        await answerCallbackQuery(
          cb.id,
          action === 'approve_prompt' ? 'Generating on Seedance…' : 'Working…',
        )
        await enqueueKlingAction({ userId, chatId, jobId, action })
        return NextResponse.json({ ok: true })
      }

      const variationCb = parseVariationCallback(data)
      if (variationCb) {
        const plan = planVariationCallback(variationCb.action)
        if (variationCb.action === 'skip' || !plan.awaitPrompt) {
          const open = await getPending(chatId)
          if (variationAwaitingJobId(open?.awaiting) === variationCb.jobId) {
            await setAwaiting(chatId, null)
          }
          await answerCallbackQuery(cb.id, 'Skipped')
          if (messageId) await editMessageReplyMarkup(chatId, messageId, {}).catch(() => {})
          return NextResponse.json({ ok: true })
        }

        const parent = await one<KlingRecreateJobRow>(
          `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
          [variationCb.jobId, userId],
        )
        if (!parent) {
          await answerCallbackQuery(cb.id, 'Job not found')
          return NextResponse.json({ ok: true })
        }
        if (!parent.character_image_url) {
          await answerCallbackQuery(cb.id, 'No character still on this job')
          return NextResponse.json({ ok: true })
        }
        await setAwaitingVariation(chatId, userId, variationCb.jobId)
        await answerCallbackQuery(cb.id, 'What should change?')
        await sendText(
          chatId,
          [
            'Send <b>one</b> message with (1) what to change and (2) how many copies (1–6).',
            'Examples: <code>softer smile, 3</code> · <code>3</code> then a new line · <code>make it night, count: 2</code>',
            'The change text is the prompt — no extra step.',
          ].join('\n'),
        )
        return NextResponse.json({ ok: true })
      }

      if (parts[1] === 'go') {
        const open = await getPending(chatId)
        const urls = open?.urls ?? []
        const namedPhotos = open?.reference_photos ?? {}
        const reference = open?.photo_url || await defaultReference(userId) || Object.values(namedPhotos)[0]
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
        const ids = await enqueueKlingRecreateJobs({
          userId, chatId, urls, referenceImageUrl: reference,
          customPrompt: pending.custom_prompt,
          referencePhotos: pending.reference_photos,
          ambiancePhotoUrl: pending.ambiance_photo_url,
        })
        await sendText(
          chatId,
          `🎬 Queued ${ids.length} recreate job${ids.length === 1 ? '' : 's'}. I’ll send analysis, ` +
            `then the character still for approval, then a quick dialogue check, then the Seedance prompt for approval, then the video.`,
        )
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
