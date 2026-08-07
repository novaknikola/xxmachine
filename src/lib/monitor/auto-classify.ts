import { after } from 'next/server'
import { one } from '@/lib/db'
import { classifyDiscoveryItem } from './process-item'

/**
 * Classify, then queue the replication itself.
 *
 * The dashboard splits these: enqueue analyses the reel, and the Replicate
 * button submits the copy_paste_v2 job separately. A caller with no UI — the
 * Telegram bot — has nobody to press that button, so it would sit analysed and
 * idle while the bot had already promised a finished video.
 *
 * Replication is queued only after classify returns, because the job needs the
 * spec that classify writes.
 */
export function scheduleAutoClassify(
  userId: string,
  itemIds: string[],
  opts?: {
    /** Queue copy_paste_v2 for the items that classified successfully. */
    thenReplicate?: boolean
    endFrame?: 'auto' | 'always' | 'off'
    repurposeCount?: number
    outputDriveFolderId?: string | null
    /** Appended to the end of every item's rendered prompt. */
    customPrompt?: string | null
    /** Called with the queue job id, or with the reason nothing was queued. */
    onQueued?: (result: { jobId: string | null; classified: number; failed: number }) => Promise<void>
  },
) {
  const ids = [...new Set(itemIds.filter(Boolean))]
  if (!ids.length) return

  after(async () => {
    const classified: string[] = []
    for (const id of ids) {
      try {
        await classifyDiscoveryItem(id, userId)
        classified.push(id)
      } catch (err) {
        console.error('[auto-classify]', id, err instanceof Error ? err.message : err)
      }
    }

    if (!opts?.thenReplicate) return

    let jobId: string | null = null
    if (classified.length) {
      try {
        const row = await one<{ id: string }>(
          `INSERT INTO generation_queue (user_id, job_type, input, total_items)
           VALUES ($1, 'copy_paste_v2', $2, $3)
           RETURNING id`,
          [
            userId,
            JSON.stringify({
              itemIds: classified,
              endFrame: opts.endFrame ?? 'auto',
              repurposeCount: opts.repurposeCount ?? 0,
              outputDriveFolderId: opts.outputDriveFolderId ?? null,
              customPrompt: opts.customPrompt ?? null,
            }),
            classified.length,
          ],
        )
        jobId = row?.id ?? null
      } catch (err) {
        console.error('[auto-classify] replicate submit failed:', err)
      }
    }

    await opts.onQueued?.({
      jobId,
      classified: classified.length,
      failed: ids.length - classified.length,
    }).catch(err => console.error('[auto-classify] onQueued:', err))
  })
}

/** Original behaviour — classify only, no replication. */
export function scheduleClassifyOnly(userId: string, itemIds: string[]) {
  const ids = [...new Set(itemIds.filter(Boolean))]
  if (!ids.length) return

  after(async () => {
    for (const id of ids) {
      try {
        await classifyDiscoveryItem(id, userId)
      } catch (err) {
        console.error(
          '[auto-classify]',
          id,
          err instanceof Error ? err.message : err,
        )
      }
    }
  })
}
