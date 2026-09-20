import { one, query } from '@/lib/db'
import { parseReelUrlList } from '@/lib/monitor/parse-reel-url'
import { downloadTelegramFile } from '@/lib/telegram-recreate'
import { uploadBuffer } from '@/lib/supabase-storage'
import { MAX_RECREATE_URLS, type KlingShotMode, type KlingStillModel } from './types'
import { variationAwaitingValue } from './variation'

const PENDING_COLUMNS = 'chat_id, user_id, photo_url, urls, awaiting, shot_mode, custom_prompt, ' +
  'reference_photos, ambiance_photo_url, pending_photo_url, still_model'

export interface RecreatePending {
  chat_id: string | number
  user_id: string | null
  photo_url: string | null
  urls: string[]
  awaiting: string | null
  shot_mode: KlingShotMode | null
  custom_prompt: string | null
  reference_photos: Record<string, string>
  ambiance_photo_url: string | null
  /** A just-uploaded photo already saved to storage, waiting for its role
   * answer ("which character, or ambiance?") — see holdPendingPhotoRole/
   * resolvePendingPhotoRole. */
  pending_photo_url: string | null
  /** Answer to the SFW/NSFW still-model question, asked once per batch
   * before Confirm — null until answered. */
  still_model: KlingStillModel | null
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

/**
 * Every uploaded photo, without exception, goes through this — download +
 * upload it, park the URL in pending_photo_url, arm 'photo_role' awaiting.
 * No fast path, no caption shortcut (2026-09-18, explicit user ask, after
 * 3 straight failed attempts at relying on Telegram photo captions — most
 * likely cause: an album/multi-select send doesn't attach a caption to
 * every photo in it, so silently trusting a caption when present just
 * papered over an unreliable signal instead of removing it). The only
 * thing this ever produces is a held photo waiting on resolvePendingPhotoRole
 * — it never writes photo_url/reference_photos/ambiance_photo_url itself.
 */
export async function holdPendingPhotoRole(opts: {
  chatId: number
  userId: string
  fileId: string
}): Promise<void> {
  const { buffer, contentType, extension } = await downloadTelegramFile(opts.fileId)
  const path = `kling-recreate-refs/${opts.userId}/${Date.now()}.${extension}`
  const photoUrl = await uploadBuffer(buffer, path, contentType)
  await query(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, pending_photo_url, awaiting, updated_at)
     VALUES ($1, $2, $3, 'photo_role', now())
     ON CONFLICT (chat_id) DO UPDATE SET
       pending_photo_url = EXCLUDED.pending_photo_url,
       awaiting = 'photo_role',
       user_id = EXCLUDED.user_id,
       updated_at = now()`,
    [opts.chatId, opts.userId, photoUrl],
  )
}

/**
 * Answer to "what does this photo represent?" — "ambient"/"ambiance"/
 * "background"/"pozadina"/"ambijent" (case-insensitive) routes it to
 * ambiance_photo_url (a style/environment reference, never an identity);
 * anything else is taken as the character's name/role and merged into
 * reference_photos. Always clears pending_photo_url/awaiting either way.
 */
const AMBIANCE_WORDS = new Set(['ambient', 'ambiance', 'background', 'ambijent', 'pozadina'])

export async function resolvePendingPhotoRole(
  chatId: number,
  userId: string,
  answer: string,
): Promise<{ kind: 'ambiance' | 'character'; label: string } | null> {
  const pending = await getPending(chatId)
  const photoUrl = pending?.pending_photo_url
  if (!photoUrl) return null

  const trimmed = answer.trim()
  const isAmbiance = AMBIANCE_WORDS.has(trimmed.toLowerCase())

  if (isAmbiance) {
    await query(
      `UPDATE telegram_recreate_pending
          SET ambiance_photo_url = $2, pending_photo_url = NULL, awaiting = NULL,
              user_id = $3, updated_at = now()
        WHERE chat_id = $1`,
      [chatId, photoUrl, userId],
    )
    return { kind: 'ambiance', label: trimmed }
  }

  await query(
    `UPDATE telegram_recreate_pending
        SET reference_photos = reference_photos || jsonb_build_object($2::text, $3::text),
            pending_photo_url = NULL, awaiting = NULL,
            user_id = $4, updated_at = now()
      WHERE chat_id = $1`,
    [chatId, trimmed, photoUrl, userId],
  )
  return { kind: 'character', label: trimmed }
}

/**
 * Loads a saved bundle's characters + ambiance into the current batch,
 * replacing whatever reference_photos/ambiance_photo_url were already
 * there — "use this bundle" means starting fresh with its set, not merging
 * with partial uploads from earlier in the batch.
 */
export async function loadBundleIntoPending(opts: {
  chatId: number
  userId: string
  referencePhotos: Record<string, string>
  ambiancePhotoUrl: string | null
}): Promise<void> {
  await query(
    `INSERT INTO telegram_recreate_pending (chat_id, user_id, reference_photos, ambiance_photo_url, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (chat_id) DO UPDATE SET
       reference_photos = EXCLUDED.reference_photos,
       ambiance_photo_url = EXCLUDED.ambiance_photo_url,
       user_id = EXCLUDED.user_id,
       updated_at = now()`,
    [opts.chatId, opts.userId, JSON.stringify(opts.referencePhotos), opts.ambiancePhotoUrl],
  )
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
  // Bare-shortcode detection off (see parseReelUrlList doc comment) — this
  // bot's free text is a script/instruction far more often than a pasted
  // shortcode, and a lone word from a multi-message script (e.g. "SETTING")
  // was silently misread as a reel URL in production 2026-09-19.
  const { parsed, invalid } = parseReelUrlList(opts.text, MAX_RECREATE_URLS, { allowBareShortcodes: false })
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

/** Answer to the SFW/NSFW still-model question, asked once per batch right before Confirm. */
export async function setPendingStillModel(chatId: number, model: KlingStillModel): Promise<void> {
  await query(
    `UPDATE telegram_recreate_pending SET still_model = $2, updated_at = now() WHERE chat_id = $1`,
    [chatId, model],
  )
}

/**
 * Optional custom instruction / manual context, collected before Recreate
 * fires. Upsert (not a plain UPDATE) so a voice note or typed note sent
 * BEFORE any photo/URL — nothing to update yet — still lands: it creates the
 * pending row early, the same way holdPendingPhotoRole already can.
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
