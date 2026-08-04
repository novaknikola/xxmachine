/**
 * The Copy-Paste batch a Telegram chat is assembling.
 *
 * Telegram sends the reference photo and the reel links as separate messages,
 * in whatever order the user chooses, so a request has to be held open between
 * messages. One batch per chat is `collecting`; a new photo closes the previous
 * one and starts fresh, which is what "I meant this photo instead" looks like.
 */
import { one, query } from '@/lib/db'
import { uploadBuffer } from '@/lib/supabase-storage'
import { downloadTelegramFile } from '@/lib/telegram'
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

export async function getBatch(batchId: string): Promise<TelegramBatch | null> {
  return await one<TelegramBatch>(`SELECT * FROM telegram_batches WHERE id = $1`, [batchId])
}
