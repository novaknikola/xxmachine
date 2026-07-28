/**
 * Nudge the Drive uploader so freshly queued files ship before provider URLs
 * expire. Cron remains the backup when this fetch fails or the secret is unset.
 */
export function kickDriveArchiveWorker(limit = 5): void {
  const secret = process.env.CRON_SECRET
  if (!secret) return
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  fetch(`${base}/api/cron/drive-archive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': secret,
    },
    body: JSON.stringify({ limit }),
  }).catch(err => console.error('[drive-archive] kick worker failed:', err))
}
