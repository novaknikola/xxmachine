import { after } from 'next/server'
import { classifyDiscoveryItem } from './process-item'

/**
 * Classify a batch of reels in the background, then report which ones
 * succeeded.
 *
 * Queueing the actual copy_paste_v2 replication used to happen right here,
 * inside the same after() continuation — but that runs in the request's
 * own process with no queue behind it, and on this self-hosted setup it can
 * silently never complete (see cron/tick.ts's "Orphaned analyses" comment
 * for the documented history). A paid WaveSpeed job has no business riding
 * on a background continuation with no retry, so replication is queued
 * synchronously instead, wherever a person (or the Telegram confirm button)
 * explicitly asks for it — this function's job is only the analysis.
 */
export function scheduleAutoClassify(
  userId: string,
  itemIds: string[],
  opts?: {
    /** Called once classification finishes, with the ids that succeeded. */
    onClassified?: (result: { classifiedIds: string[]; failed: number }) => Promise<void>
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

    await opts?.onClassified?.({
      classifiedIds: classified,
      failed: ids.length - classified.length,
    }).catch(err => console.error('[auto-classify] onClassified:', err))
  })
}
