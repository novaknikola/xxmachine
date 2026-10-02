/**
 * Photo Replicator phase 2 — the preview's buttons (Telegram webhook).
 *
 * callback_data is `phok|phre|phno:<photo job id>:<attempt>`. Each tap is one
 * conditional UPDATE on (status = 'awaiting_approval', attempt = <attempt>), so
 * a double tap, a redelivered callback, or a button under an older preview
 * after a Regenerate finds nothing to claim and changes nothing.
 */
import { one, query } from '@/lib/db'
import {
  answerCallbackQuery,
  editMessageCaption,
  editMessageReplyMarkup,
  editMessageText,
  sendText,
} from '@/lib/telegram'
import { findUserByChat } from './telegram-batch'
import {
  MAX_PHOTO_GENERATIONS,
  archivePhotoJob,
  queuePhotoGeneration,
  type PhotoJobRow,
  type PhotoJobStatus,
} from './photo-jobs'
import { photoApprovalKeyboard } from './photo-generate'

export const PHOTO_CALLBACK_ACTIONS = ['phok', 'phre', 'phno'] as const
export type PhotoCallbackAction = (typeof PHOTO_CALLBACK_ACTIONS)[number]

export function isPhotoCallback(action: string): action is PhotoCallbackAction {
  return (PHOTO_CALLBACK_ACTIONS as readonly string[]).includes(action)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NEXT: Record<PhotoCallbackAction, PhotoJobStatus> = { phok: 'approved', phre: 'queued', phno: 'rejected' }

export type PhotoApprovalOutcome = 'approved' | 'regenerating' | 'rejected' | 'already_handled' | 'not_linked' | 'invalid' | 'queue_failed'

export async function handlePhotoApproval(opts: {
  callbackId: string
  data: string
  chatId?: number
  messageId?: number
}): Promise<PhotoApprovalOutcome> {
  const [action, jobId, attemptRaw] = opts.data.split(':')
  const attempt = Number(attemptRaw)
  if (!isPhotoCallback(action) || !UUID.test(jobId ?? '') || !Number.isInteger(attempt) || attempt < 1) {
    await answerCallbackQuery(opts.callbackId, 'Invalid action').catch(() => {})
    return 'invalid'
  }
  const userId = opts.chatId != null ? await findUserByChat(opts.chatId) : null
  if (opts.chatId == null || !userId) {
    await answerCallbackQuery(opts.callbackId, 'Chat not linked').catch(() => {})
    return 'not_linked'
  }
  const chatId = opts.chatId

  const next = NEXT[action]
  const job = await one<PhotoJobRow>(
    `UPDATE photo_replicator_jobs
        SET status = $4,
            approved_at = CASE WHEN $4 = 'approved' THEN now() ELSE approved_at END,
            completed_at = CASE WHEN $4 = 'rejected' THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'awaiting_approval' AND attempt = $3
        AND ($4 <> 'queued' OR attempt < $5)
      RETURNING *`,
    [jobId, userId, attempt, next, MAX_PHOTO_GENERATIONS],
  )
  if (!job) {
    await answerCallbackQuery(opts.callbackId, 'Already handled').catch(() => {})
    return 'already_handled'
  }
  console.log(`[photo-approval] job ${jobId} attempt ${attempt}: ${action} → ${next}`)

  const label = action === 'phok'
    ? '✅ Odobreno — ide na Drive (raw), pa na farmu.'
    : action === 'phre'
      ? `🔁 Ponovo generišem (pokušaj ${attempt + 1}/${MAX_PHOTO_GENERATIONS})…`
      : '✖️ Odbijeno — ništa ne ide na Drive ni na farmu.'
  await answerCallbackQuery(opts.callbackId, action === 'phok' ? 'Approved' : action === 'phre' ? 'Regenerating' : 'Rejected').catch(() => {})
  if (opts.messageId) {
    await editMessageReplyMarkup(chatId, opts.messageId, {}).catch(() => {})
    // A carousel's buttons sit on a text message under the album; a post's on the photo itself.
    const edit = job.format === 'carousel' ? editMessageText : editMessageCaption
    await edit(chatId, opts.messageId, label).catch(() => {})
  }

  if (action === 'phok') {
    const archived = await archivePhotoJob(jobId).catch(err => {
      console.error(`[photo-approval] job ${jobId} archive failed:`, err)
      return 'error' as const
    })
    if (archived !== 'archiving') {
      await sendText(chatId, '⚠️ Odobreno, ali Drive upload nije pokrenut — rezultat je sačuvan. Čekiraj Pošalji u Sheet-u kad Drive bude dostupan.').catch(() => {})
    }
    return 'approved'
  }

  if (action === 'phre') {
    try {
      await queuePhotoGeneration(userId, jobId)
      return 'regenerating'
    } catch (err) {
      console.error(`[photo-approval] job ${jobId} regenerate queue failed:`, err)
      // Back to the approval state so the buttons can be used again.
      await query(
        `UPDATE photo_replicator_jobs SET status = 'awaiting_approval', updated_at = now() WHERE id = $1 AND status = 'queued'`,
        [jobId],
      )
      if (opts.messageId) {
        await editMessageReplyMarkup(chatId, opts.messageId, photoApprovalKeyboard(jobId, attempt)).catch(() => {})
      }
      await sendText(chatId, '❌ Regenerate nije pokrenut — pritisni dugme ponovo.').catch(() => {})
      return 'queue_failed'
    }
  }

  return 'rejected'
}
