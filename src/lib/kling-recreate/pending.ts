import { one, query } from '@/lib/db'
import { parseReelUrlList } from '@/lib/monitor/parse-reel-url'
import { downloadTelegramFile } from '@/lib/telegram-recreate'
import { uploadBuffer } from '@/lib/supabase-storage'
import { MAX_RECREATE_URLS, type KlingShotMode } from './types'
import { variationAwaitingValue } from './variation'

const PENDING_COLUMNS = 'chat_id, user_id, photo_url, urls, awaiting, shot_mode, custom_prompt, reference_photos'

export interface RecreatePending {
  chat_id: string | number
  user_id: string | null
  photo_url: string | null
  urls: string[]
  awaiting: string | null
  shot_mode: KlingShotMode | null
  custom_prompt: string | null
  reference_photos: Record<string, string>
}

export async function getPending(chatId: number): Promise<RecreatePending | null> {
  return one<RecreatePending>(
    `SELECT ${PENDING_COLUMNS} FROM telegram_recreate_pending WHERE chat_id = $1`,
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
    `INSERT INTO telegram_recreate_pending (chat_id, user_id) VALUES ($1, $2) RETURNING ${PENDING_COLUMNS}`,
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
     RETURNING ${PENDING_COLUMNS}`,
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

/**
 * Multi-identity path: a photo sent WITH a caption is that character's
 * named reference, merged into reference_photos (a name->url map) instead
 * of overwriting the single photo_url. Upsert so this can be the very first
 * thing sent, same reasoning as setPendingCustomPrompt.
 */
export async function attachNamedPhotoFromTelegram(opts: {
  chatId: number
  userId: string
  fileId: string
  name: string
}): Promise<RecreatePending> {
  const { buffer, contentType, extension } = await downloadTelegramFile(opts.fileId)
  const path = `kling-recreate-refs/${opts.userId}/${Date.now()}.${extension}`
  const photoUrl = await uploadBuffer(buffer, path, contentType)
  const row = await one<RecreatePending>(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, reference_photos, updated_at)
     VALUES ($1, $2, jsonb_build_object($3::text, $4::text), now())
     ON CONFLICT (chat_id) DO UPDATE SET
       reference_photos = telegram_recreate_pending.reference_photos || jsonb_build_object($3::text, $4::text),
       user_id = EXCLUDED.user_id,
       updated_at = now()
     RETURNING ${PENDING_COLUMNS}`,
    [opts.chatId, opts.userId, opts.name, photoUrl],
  )
  return row!
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
      RETURNING ${PENDING_COLUMNS}`,
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

/** Answer to the "One shot or Multi-shot?" question, asked once per batch before analysis. */
export async function setPendingShotMode(chatId: number, mode: KlingShotMode): Promise<void> {
  await query(
    `UPDATE telegram_recreate_pending SET shot_mode = $2, updated_at = now() WHERE chat_id = $1`,
    [chatId, mode],
  )
}

/**
 * Optional custom instruction / manual context, collected before Recreate
 * fires. Upsert (not a plain UPDATE) so a voice note or typed note sent
 * BEFORE any photo/URL — nothing to update yet — still lands: it creates the
 * pending row early, the same way setPendingPhoto already can.
 */
export async function setPendingCustomPrompt(chatId: number, userId: string, text: string | null): Promise<void> {
  await query(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, custom_prompt, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET
       custom_prompt = EXCLUDED.custom_prompt,
       user_id = EXCLUDED.user_id,
       updated_at = now()`,
    [chatId, userId, text],
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
      RETURNING ${PENDING_COLUMNS}`,
    [chatId],
  )
}

/** Same atomic claim as claimPending, for the script-only path — gated on a
 * non-empty script instead of on urls (there are none for this path). */
export async function claimPendingForScript(chatId: number): Promise<RecreatePending | null> {
  return one<RecreatePending>(
    `DELETE FROM telegram_recreate_pending
      WHERE chat_id = $1 AND coalesce(custom_prompt, '') <> ''
      RETURNING ${PENDING_COLUMNS}`,
    [chatId],
  )
}
