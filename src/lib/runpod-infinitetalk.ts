/**
 * InfiniteTalk on RunPod serverless — a still plus an audio track becomes a
 * talking clip.
 *
 * Same async contract as the Seedance endpoint: POST /run returns a job id,
 * then /status/{id} is polled until COMPLETED or FAILED. Lip-sync renders run
 * longer than image-to-video, so the deadline here is wider.
 */

const BASE = 'https://api.runpod.ai/v2'
const ENDPOINT = 'infinitetalk'

export type TalkResolution = '480p' | '720p'

export interface InfiniteTalkInput {
  /** Publicly reachable still — RunPod fetches it. */
  imageUrl: string
  /** Publicly reachable wav/mp3 — likewise fetched, not uploaded. */
  audioUrl: string
  /** Scene direction. Short; the audio drives the performance. */
  prompt: string
  resolution: TalkResolution
  /**
   * Off by default. The subject matter here trips general-purpose filters
   * often enough that leaving it on means paying for calls that come back
   * refused, and the operator has already reviewed the input.
   */
  enableSafetyChecker?: boolean
  apiKey: string
  signal?: AbortSignal
}

export class InfiniteTalkError extends Error {}

interface RunPodStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  output?: unknown
  error?: unknown
}

/** Walk the output for the first URL — worker output shape is not a contract. */
function videoUrlFrom(output: unknown): string | null {
  if (!output) return null
  if (typeof output === 'string') return output.startsWith('http') ? output : null
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = videoUrlFrom(item)
      if (found) return found
    }
    return null
  }
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    for (const key of ['video', 'video_url', 'videoUrl', 'url', 'output', 'result']) {
      const found = videoUrlFrom(o[key])
      if (found) return found
    }
  }
  return null
}

export interface InfiniteTalkResult {
  videoUrl: string
  jobId: string
  elapsedMs: number
  /** Reported by the endpoint alongside the video, when present. */
  costUsd: number | null
}

export async function generateTalkingVideo(input: InfiniteTalkInput): Promise<InfiniteTalkResult> {
  const startedAt = Date.now()

  const submit = await fetch(`${BASE}/${ENDPOINT}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      input: {
        prompt: input.prompt,
        image: input.imageUrl,
        audio: input.audioUrl,
        resolution: input.resolution,
        enable_safety_checker: input.enableSafetyChecker ?? false,
      },
    }),
    signal: input.signal,
  })

  const submitBody = await submit.json().catch(() => null) as { id?: string; error?: string } | null
  if (!submit.ok || !submitBody?.id) {
    throw new InfiniteTalkError(submitBody?.error ?? `RunPod rejected the job (${submit.status})`)
  }
  const jobId = submitBody.id

  // 20 minutes: lip-sync is slower than i2v and a cold worker queues first.
  const deadline = Date.now() + 20 * 60_000
  let delay = 4_000

  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new InfiniteTalkError('Aborted')
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.2, 12_000)

    const res = await fetch(`${BASE}/${ENDPOINT}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    })
    const data = await res.json().catch(() => null) as RunPodStatus | null
    if (!data) continue

    if (data.status === 'COMPLETED') {
      const videoUrl = videoUrlFrom(data.output)
      if (!videoUrl) {
        throw new InfiniteTalkError(
          `Completed with no video URL. Output: ${JSON.stringify(data.output).slice(0, 300)}`,
        )
      }
      const rawCost = (data.output as { cost?: unknown } | null)?.cost
      return {
        videoUrl,
        jobId,
        elapsedMs: Date.now() - startedAt,
        costUsd: typeof rawCost === 'number' ? rawCost : null,
      }
    }

    if (data.status === 'FAILED' || data.status === 'CANCELLED' || data.status === 'TIMED_OUT') {
      throw new InfiniteTalkError(
        `RunPod job ${data.status}: ${JSON.stringify(data.error ?? {}).slice(0, 300)}`,
      )
    }
  }

  throw new InfiniteTalkError(`RunPod job ${jobId} did not finish within 20 minutes`)
}
