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
 * Store a reference photo and start a batch around it. Any batch still open in
 * this chat is cancelled first — sending a second photo means the user is
 * restarting, not adding a second identity.
 */
export async function startBatchWithPhoto(opts: {
  userId: string
  chatId: number | string
  fileId: string
}): Promise<TelegramBatch> {
  const { buffer, contentType, extension } = await downloadTelegramFile(opts.fileId)
  const path = `telegram/${opts.userId}/ref_${Date.now()}.${extension}`
  const referenceImageUrl = await uploadBuffer(buffer, path, contentType)

  await query(
    `UPDATE telegram_batches SET status = 'cancelled', updated_at = now()
      WHERE chat_id = $1 AND status = 'collecting'`,
    [String(opts.chatId)],
  )

  const row = await one<TelegramBatch>(
    `INSERT INTO telegram_batches (user_id, chat_id, reference_image_url)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [opts.userId, String(opts.chatId), referenceImageUrl],
  )
  return row!
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
