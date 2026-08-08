/**
 * The Copy-Paste batch a Telegram chat is assembling.
 *
 * Telegram sends the reference photo and the reel links as separate messages,
 * in whatever order the user chooses, so a request has to be held open between
 * messages. One batch per chat is `collecting`; a new photo closes the previous
 * one and starts fresh, which is what "I meant this photo instead" looks like.
 */
import { one, query, rows } from '@/lib/db'
import { downloadTelegramFile, editMessageReplyMarkup, sendText } from '@/lib/telegram'
import { uploadBuffer } from '@/lib/supabase-storage'
import { parseReelUrlList } from './parse-reel-url'
import { MAX_URLS } from './enqueue-from-urls'

export interface TelegramBatch {
  id: string
  user_id: string
  chat_id: string
  reference_image_url: string | null
  urls: string[]
  status: string
  prompt_message_id: string | number | null
  custom_prompt: string | null
  awaiting_prompt: boolean
  prompt_asked: boolean
  /** Items classified and awaiting the "confirm replicate?" tap — empty once confirmed. */
  classified_item_ids: string[]
  /** Every item created for this batch, set synchronously at submit time — see finalizeBatchClassification. */
  item_ids: string[]
}

export async function findUserByChat(chatId: number | string): Promise<string | null> {
  const row = await one<{ id: string }>(
    `SELECT id FROM users WHERE telegram_chat_id = $1 LIMIT 1`,
    [String(chatId)],
  )
  return row?.id ?? null
}

export async function openBatch(chatId: number | string): Promise<TelegramBatch | null> {
  return await one<TelegramBatch>(
    `SELECT * FROM telegram_batches WHERE chat_id = $1 AND status = 'collecting' LIMIT 1`,
    [String(chatId)],
  )
}

/**
 * Attach a reference photo to the chat's batch.
 *
 * A photo arriving while a batch is open without one is the user completing
 * that batch, not starting over — links sent before the photo must survive.
 * Cancelling unconditionally meant every reel had to be sent twice, once
 * before the photo and again after it.
 *
 * A photo arriving when the batch already HAS one is the other case — "use
 * this photo instead" — and does restart, since two identities in one batch
 * has no meaning.
 */
export async function startBatchWithPhoto(opts: {
  userId: string
  chatId: number | string
  fileId: string
}): Promise<{ batch: TelegramBatch; replacedPrevious: boolean }> {
  const { buffer, contentType, extension } = await downloadTelegramFile(opts.fileId)
  const path = `telegram/${opts.userId}/ref_${Date.now()}.${extension}`
  const referenceImageUrl = await uploadBuffer(buffer, path, contentType)

  const open = await openBatch(opts.chatId)

  if (open && !open.reference_image_url) {
    const updated = await one<TelegramBatch>(
      `UPDATE telegram_batches
          SET reference_image_url = $2, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [open.id, referenceImageUrl],
    )
    return { batch: updated!, replacedPrevious: false }
  }

  if (open) {
    await query(
      `UPDATE telegram_batches SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [open.id],
    )
  }

  const row = await one<TelegramBatch>(
    `INSERT INTO telegram_batches (user_id, chat_id, reference_image_url)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [opts.userId, String(opts.chatId), referenceImageUrl],
  )
  return { batch: row!, replacedPrevious: Boolean(open) }
}

export interface AddUrlsResult {
  batch: TelegramBatch
  added: number
  duplicates: number
  invalid: string[]
  atCap: boolean
}

/**
 * Append reel links to the open batch, creating one if the links arrived
 * before the photo. Deduped, because forwarding the same reel twice should not
 * bill twice.
 */
export async function addUrlsToBatch(opts: {
  userId: string
  chatId: number | string
  text: string
}): Promise<AddUrlsResult | null> {
  const { parsed, invalid } = parseReelUrlList(opts.text, MAX_URLS)
  if (!parsed.length) return null

  let batch = await openBatch(opts.chatId)
  if (!batch) {
    batch = (await one<TelegramBatch>(
      `INSERT INTO telegram_batches (user_id, chat_id) VALUES ($1, $2) RETURNING *`,
      [opts.userId, String(opts.chatId)],
    ))!
  }

  const existing = new Set(batch.urls.map(u => u.toLowerCase()))
  const incoming: string[] = []
  let duplicates = 0
  for (const p of parsed) {
    const key = p.permalink.toLowerCase()
    if (existing.has(key)) { duplicates++; continue }
    existing.add(key)
    incoming.push(p.permalink)
  }

  const room = Math.max(0, MAX_URLS - batch.urls.length)
  const toAdd = incoming.slice(0, room)

  const updated = await one<TelegramBatch>(
    `UPDATE telegram_batches
        SET urls = urls || $2::text[], updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [batch.id, toAdd],
  )

  return {
    batch: updated!,
    added: toAdd.length,
    duplicates,
    invalid,
    atCap: incoming.length > toAdd.length,
  }
}

/** 'collecting' is also a target: a failed submit is returned to the user to retry. */
export async function markBatch(
  batchId: string,
  status: 'collecting' | 'submitted' | 'cancelled',
): Promise<void> {
  await query(
    `UPDATE telegram_batches SET status = $2, updated_at = now() WHERE id = $1`,
    [batchId, status],
  )
}

export async function setPromptMessage(batchId: string, messageId: number): Promise<void> {
  await query(
    `UPDATE telegram_batches SET prompt_message_id = $2 WHERE id = $1`,
    [batchId, messageId],
  )
}

/** Text appended to every item's rendered prompt when this batch replicates. Empty clears it. */
export async function setCustomPrompt(batchId: string, text: string): Promise<void> {
  await query(
    `UPDATE telegram_batches SET custom_prompt = $2, updated_at = now() WHERE id = $1`,
    [batchId, text.trim() || null],
  )
}

/** Arms the "next text message is the prompt, not reel links" flag. */
export async function setAwaitingPrompt(batchId: string, awaiting: boolean): Promise<void> {
  await query(
    `UPDATE telegram_batches SET awaiting_prompt = $2, updated_at = now() WHERE id = $1`,
    [batchId, awaiting],
  )
}

/** Marks that the "add anything to the prompt?" choice has been offered, so it is not asked again. */
export async function markPromptAsked(batchId: string): Promise<void> {
  await query(
    `UPDATE telegram_batches SET prompt_asked = true, updated_at = now() WHERE id = $1`,
    [batchId],
  )
}

export async function getBatch(batchId: string): Promise<TelegramBatch | null> {
  return await one<TelegramBatch>(`SELECT * FROM telegram_batches WHERE id = $1`, [batchId])
}

/** Records which items classification succeeded for, awaiting the confirm tap. */
export async function setClassifiedItemIds(batchId: string, ids: string[]): Promise<void> {
  await query(
    `UPDATE telegram_batches SET classified_item_ids = $2::uuid[], updated_at = now() WHERE id = $1`,
    [batchId, ids],
  )
}

/**
 * Atomically claims and clears classified_item_ids, returning the ids that
 * were there — or null if there was nothing left to claim.
 *
 * A plain read-then-write (read classified_item_ids, then separately clear
 * it) lets two concurrent Confirm taps — a genuine double-tap, or Telegram
 * redelivering the same callback_query — both pass the "is there anything to
 * confirm" check before either write lands, and both queue the same paid
 * copy_paste_v2 job. The UPDATE...WHERE...RETURNING here is the check: only
 * one concurrent caller can ever see a non-null result, so this must run
 * first, before any other await (including Telegram API calls), to keep the
 * race window at a single DB round trip.
 */
export async function claimClassifiedItemIds(batchId: string): Promise<string[] | null> {
  // RETURNING on a plain UPDATE reflects the row AFTER the SET, so a bare
  // `SET classified_item_ids = '{}' ... RETURNING classified_item_ids` always
  // returns '{}' — the very value it just wrote, not the ids being claimed.
  // The FOR UPDATE subquery reads (and locks) the pre-clear value so it can
  // still be returned, while keeping the whole thing one atomic statement: a
  // second concurrent call blocks on the lock until the first commits, then
  // finds the row already cleared and its own WHERE no longer matches.
  const row = await one<{ classified_item_ids: string[] }>(
    `UPDATE telegram_batches AS tb
        SET classified_item_ids = '{}', updated_at = now()
       FROM (
         SELECT id, classified_item_ids FROM telegram_batches
          WHERE id = $1 AND coalesce(array_length(classified_item_ids, 1), 0) > 0
          FOR UPDATE
       ) AS prev
      WHERE tb.id = prev.id
      RETURNING prev.classified_item_ids`,
    [batchId],
  )
  return row?.classified_item_ids ?? null
}

/** Every item created for this batch — set once, right after submit, independent of whether classification ever reports back. */
export async function setItemIds(batchId: string, ids: string[]): Promise<void> {
  await query(
    `UPDATE telegram_batches SET item_ids = $2::uuid[], updated_at = now() WHERE id = $1`,
    [batchId, ids],
  )
}

/**
 * Sends the "confirm replicate?" (or "nothing could be replicated") message
 * and, on success, records which items are ready — the one place this logic
 * lives, called both right after classification finishes and by cron's
 * safety-net sweep for batches where that first call never happened.
 *
 * Re-reads status from discovery_items rather than trusting a caller-passed
 * list, so it gives the same answer regardless of which of the two ever
 * actually calls it.
 *
 * Clears item_ids up front, before sending anything — this is the one-shot
 * guard that keeps cron's sweep from matching the same batch again. Without
 * it, a batch whose items never reached 'classified' (nothing to replicate,
 * or — worse — items that moved past 'classified' into 'done' after the user
 * already confirmed and it replicated successfully) would match the sweep's
 * WHERE clause forever, re-sending "nothing could be replicated" every tick
 * indefinitely. Confirmed happening in production: a batch that had already
 * finished replicating got this message resent once a minute for an hour.
 */
export async function finalizeBatchClassification(batch: TelegramBatch): Promise<void> {
  if (!batch.item_ids.length) return

  const items = await rows<{ id: string; replicate_status: string }>(
    `SELECT id, replicate_status FROM discovery_items WHERE id = ANY($1::uuid[])`,
    [batch.item_ids],
  )
  const classifiedIds = items.filter(i => i.replicate_status === 'classified').map(i => i.id)
  const failed = items.length - classifiedIds.length

  await query(`UPDATE telegram_batches SET item_ids = '{}', updated_at = now() WHERE id = $1`, [batch.id])

  if (!classifiedIds.length) {
    await sendText(
      batch.chat_id,
      `⚠️ Analysis finished but nothing could be replicated${failed ? ` — ${failed} failed to analyse` : ''}.`,
    ).catch(() => { /* the chat may have been closed */ })
    return
  }

  await setClassifiedItemIds(batch.id, classifiedIds)
  const sent = await sendText(
    batch.chat_id,
    `✅ Analyzed ${classifiedIds.length} reel${classifiedIds.length === 1 ? '' : 's'}${failed ? ` · ${failed} could not be analysed` : ''}. Confirm to start generating?`,
  ).catch(() => null) as { message_id?: number } | null
  if (sent?.message_id) {
    await editMessageReplyMarkup(batch.chat_id, sent.message_id, {
      inline_keyboard: [[
        { text: '▶️ Confirm Replicate', callback_data: `cpgo:${batch.id}` },
        { text: '✖️ Cancel', callback_data: `cpcancel:${batch.id}` },
      ]],
    }).catch(() => {})
  }
}
