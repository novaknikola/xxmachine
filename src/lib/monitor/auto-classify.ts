import { after } from 'next/server'
import { classifyDiscoveryItem } from './process-item'

/**
 * Kick off classify (frames + technique) after enqueue without blocking the HTTP response.
 */
export function scheduleAutoClassify(userId: string, itemIds: string[]) {
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
