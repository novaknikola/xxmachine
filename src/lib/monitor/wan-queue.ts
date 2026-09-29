import { one } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import { getRepurposeSettings } from './telegram-repurpose'

/**
 * 'acquire' resolves + stores the source and then makes the scene still
 * (Sheet-started jobs); 'still' makes scene stills for approval; 'video' runs
 * the paid Wan call.
 */
export type CopyPasteWanPhase = 'acquire' | 'still' | 'video'

/**
 * One copy_paste_wan queue job, started right away instead of waiting up to a
 * minute for cron — same claim-then-kick pattern queue/submit uses. Lifted out
 * of the Telegram webhook so the Sheet bridge queues through the same path.
 */
export async function queueCopyPasteWan(userId: string, jobIds: string[], phase: CopyPasteWanPhase): Promise<void> {
  const settings = await getRepurposeSettings(userId)
  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'copy_paste_wan', $2, $3)
     RETURNING id`,
    [
      userId,
      JSON.stringify({
        jobIds,
        phase,
        repurposeCount: settings.variantCount,
        outputDriveFolderId: settings.outputDriveFolderId,
      }),
      jobIds.length,
    ],
  )
  if (!row) throw new Error('Queue insert returned no row')
  const secret = process.env.CRON_SECRET
  if (!secret) return
  const claimed = await one<{ id: string }>(
    `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
      WHERE id=$1 AND status='pending' RETURNING id`,
    [row.id],
  ).catch(() => null)
  if (claimed) {
    fetch(`${internalBaseUrl()}/api/queue/process/${row.id}`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
    }).catch(err => console.error('[wan-queue] fire copy_paste_wan worker:', err))
  }
}
