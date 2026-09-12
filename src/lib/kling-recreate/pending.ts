import { one, query } from '@/lib/db'
import { parseReelUrlList } from '@/lib/monitor/parse-reel-url'
import { downloadTelegramFile } from '@/lib/telegram-recreate'
import { uploadBuffer } from '@/lib/supabase-storage'
import { MAX_RECREATE_URLS } from './types'
import { variationAwaitingValue } from './variation'

export interface RecreatePending {
  chat_id: string | number
  user_id: string | null
  photo_url: string | null
  urls: string[]
  awaiting: string | null
}

export async function getPending(chatId: number): Promise<RecreatePending | null> {
  return one<RecreatePending>(
    `SELECT chat_id, user_id, photo_url, urls, awaiting FROM telegram_recreate_pending WHERE chat_id = $1`,
    [chatId],
  )
}

export async function clearPending(chatId: number): Promise<void> {
  await query(`DELETE FROM telegram_recreate_pending WHERE chat_id = $1`, [chatId])
}

export async function upsertPending(chatId: number, userId: string): Promise<RecreatePending> {
  const existing = await getPending(chatId)
  if (existing) return existing
  const row = await one<RecreatePending>(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id) VALUES ($1, $2) RETURNING chat_id, user_id, photo_url, urls, awaiting`,
    [chatId, userId],
  )
  return row!
}

export async function setPendingPhoto(chatId: number, userId: string, photoUrl: string): Promise<RecreatePending> {
  const row = await one<RecreatePending>(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, photo_url, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET
       photo_url = EXCLUDED.photo_url,
       user_id = EXCLUDED.user_id,
       updated_at = now()
     RETURNING chat_id, user_id, photo_url, urls, awaiting`,
    [chatId, userId, photoUrl],
  )
  return row!
}

export async function attachPhotoFromTelegram(opts: {
  chatId: number
  userId: string
  fileId: string
}): Promise<RecreatePending> {
  const { buffer, contentType, extension } = await downloadTelegramFile(opts.fileId)
  const path = `kling-recreate-refs/${opts.userId}/${Date.now()}.${extension}`
  const photoUrl = await uploadBuffer(buffer, path, contentType)
  return setPendingPhoto(opts.chatId, opts.userId, photoUrl)
}

export interface AddUrlsResult {
  pending: RecreatePending
  added: number
  duplicates: number
  invalid: string[]
  atCap: boolean
}

export async function addUrlsToPending(opts: {
  chatId: number
  userId: string
  text: string
}): Promise<AddUrlsResult | null> {
  const { parsed, invalid } = parseReelUrlList(opts.text, MAX_RECREATE_URLS)
  if (!parsed.length) return null

  let pending = await upsertPending(opts.chatId, opts.userId)
  const existing = new Set((pending.urls ?? []).map(u => u.toLowerCase()))
  const incoming: string[] = []
  let duplicates = 0
  for (const p of parsed) {
    const key = p.permalink.toLowerCase()
    if (existing.has(key)) { duplicates++; continue }
    existing.add(key)
    incoming.push(p.permalink)
  }

  const room = Math.max(0, MAX_RECREATE_URLS - (pending.urls?.length ?? 0))
  const toAdd = incoming.slice(0, room)

  const updated = await one<RecreatePending>(
    `UPDATE telegram_recreate_pending
        SET urls = urls || $2::text[], user_id = $3, updated_at = now()
      WHERE chat_id = $1
      RETURNING chat_id, user_id, photo_url, urls, awaiting`,
    [opts.chatId, toAdd, opts.userId],
  )

  return {
    pending: updated!,
    added: toAdd.length,
    duplicates,
    invalid,
    atCap: incoming.length > toAdd.length,
  }
}

export async function setAwaiting(chatId: number, awaiting: string | null): Promise<void> {
  await query(
    `UPDATE telegram_recreate_pending SET awaiting = $2, updated_at = now() WHERE chat_id = $1`,
    [chatId, awaiting],
  )
}

/** Arms the next text message as a variation delta for this job (not reel URLs). */
export async function setAwaitingVariation(chatId: number, userId: string, jobId: string): Promise<void> {
  await query(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, awaiting, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET
       awaiting = EXCLUDED.awaiting,
       user_id = EXCLUDED.user_id,
       updated_at = now()`,
    [chatId, userId, variationAwaitingValue(jobId)],
  )
}

/** Atomically take the open batch so a double-tap Confirm cannot enqueue twice. */
export async function claimPending(chatId: number): Promise<RecreatePending | null> {
  return one<RecreatePending>(
    `DELETE FROM telegram_recreate_pending
      WHERE chat_id = $1 AND coalesce(array_length(urls, 1), 0) > 0
      RETURNING chat_id, user_id, photo_url, urls, awaiting`,
    [chatId],
  )
}
