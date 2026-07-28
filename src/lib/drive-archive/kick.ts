/**
 * Nudge the Drive uploader so freshly queued files ship before provider URLs
 * expire. Cron remains the backup when this fetch fails or the secret is unset.
 *
 * Debounced: rapid raw+ready enqueues collapse into one worker run so parallel
 * HTTP handlers do not race on folder creation.
 */

let kickTimer: ReturnType<typeof setTimeout> | null = null
let kickLimit = 5

export function kickDriveArchiveWorker(limit = 5): void {
  kickLimit = Math.max(kickLimit, limit)
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    const secret = process.env.CRON_SECRET
    const pendingLimit = kickLimit
    kickTimer = null
    kickLimit = 5
    if (!secret) return
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

    fetch(`${base}/api/cron/drive-archive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': secret,
      },
      body: JSON.stringify({ limit: pendingLimit }),
    }).catch(err => console.error('[drive-archive] kick worker failed:', err))
  }, 250)
}
