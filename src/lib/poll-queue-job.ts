export interface QueueJob {
  id: string
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled' | 'paused'
  done_items: number
  total_items: number
  progress: number
  error: string | null
  output: { urls?: string[] } | null
}

const POLL_INTERVAL_MS = 2000
// Generous ceiling for a stuck job, not a real expectation — repurpose jobs
// finish in well under a minute.
const MAX_POLL_MS = 15 * 60_000

/**
 * Poll a generation_queue job to completion with short GETs instead of one
 * held-open connection. Repurpose's "Run" button used to send the whole file
 * and wait through the entire ffmpeg run on a single fetch() — a client
 * network that couldn't sustain a long connection (nginx logged bare 499s:
 * the browser side closing the socket, not a server error or timeout) killed
 * it every time. Submitting through the queue and polling means no single
 * request stays open more than a couple of seconds.
 */
export async function pollQueueJob(
  jobId: string,
  onProgress: (doneItems: number, totalItems: number) => void,
  shouldStop: () => boolean,
): Promise<QueueJob | null> {
  const deadline = Date.now() + MAX_POLL_MS
  while (Date.now() < deadline) {
    if (shouldStop()) {
      fetch(`/api/queue/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }).catch(() => {})
      return null
    }

    const res = await fetch(`/api/queue/${jobId}`)
    if (res.ok) {
      const { job } = await res.json() as { job: QueueJob }
      onProgress(job.done_items, job.total_items)
      if (job.status === 'done') return job
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(job.error ?? `Job ${job.status}`)
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error('Timed out waiting for the job to finish')
}
