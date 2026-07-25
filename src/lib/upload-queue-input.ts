export interface UploadedQueueItem {
  videoUrl: string
  videoName: string
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

/**
 * Uploads a file to /api/queue/upload-input, retrying on transient failures
 * (e.g. an empty body arriving under load during large sequential batches).
 */
export async function uploadQueueInput(file: File): Promise<UploadedQueueItem> {
  let lastError = 'Upload failed'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('/api/queue/upload-input', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'video/mp4',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      })
      if (res.ok) {
        const { url, name } = await res.json() as { url: string; name: string }
        return { videoUrl: url, videoName: name }
      }
      const e = await res.json().catch(() => ({})) as { error?: string }
      lastError = e.error ?? `Upload failed (${res.status})`
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Upload failed'
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }

  throw new Error(`${file.name} (${file.size} bytes): ${lastError}`)
}
