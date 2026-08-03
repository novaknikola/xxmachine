/**
 * Seedance v1.5 Pro image-to-video on RunPod serverless.
 *
 * RunPod's async contract: POST /run returns a job id immediately, then
 * /status/{id} is polled until COMPLETED or FAILED. A cold endpoint sits in
 * IN_QUEUE for a while before IN_PROGRESS, so the timeout has to cover a cold
 * start plus the render, not just the render.
 */

const BASE = 'https://api.runpod.ai/v2'
const ENDPOINT = 'seedance-v1-5-pro-i2v'

export type SeedanceResolution = '480p' | '720p'

export interface SeedanceI2VInput {
  /** Publicly reachable still — RunPod fetches it, nothing is uploaded here. */
  imageUrl: string
  prompt: string
  /** Seconds of video. */
  duration: number
  resolution: SeedanceResolution
  /** Locked camera reads as a tripod; false gives the handheld feel a selfie has. */
  cameraFixed: boolean
  /** -1 asks the endpoint for a random seed, which is what makes each run differ. */
  seed?: number
  generateAudio?: boolean
  apiKey: string
  signal?: AbortSignal
}

export class SeedanceError extends Error {}

interface RunPodStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  output?: unknown
  error?: unknown
}

/** Pull the first video URL out of whatever shape the worker returns. */
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

export interface SeedanceResult {
  videoUrl: string
  jobId: string
  /** Wall clock from submit to COMPLETED, for the cost/latency picture. */
  elapsedMs: number
  /**
   * What the run actually cost, as reported by the endpoint — it returns
   * `cost` alongside the video. Recording the real number beats estimating
   * from a per-second rate, since queue time and retries are already in it.
   */
  costUsd: number | null
}

/** Measured on a 5s 720p run: $0.26, 61.6s execution after a 6s cold start. */
export const SEEDANCE_REFERENCE_COST_USD = 0.26
export const SEEDANCE_REFERENCE_SECONDS = 5

export async function generateSeedanceVideo(input: SeedanceI2VInput): Promise<SeedanceResult> {
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
        aspect_ratio: '9:16',
        duration: input.duration,
        resolution: input.resolution,
        camera_fixed: input.cameraFixed,
        generate_audio: input.generateAudio ?? false,
        seed: input.seed ?? -1,
      },
    }),
    signal: input.signal,
  })

  const submitBody = await submit.json().catch(() => null) as { id?: string; error?: string } | null
  if (!submit.ok || !submitBody?.id) {
    throw new SeedanceError(
      submitBody?.error ?? `RunPod rejected the job (${submit.status})`,
    )
  }
  const jobId = submitBody.id

  // 10 minutes: a cold worker can queue for minutes before it starts rendering.
  const deadline = Date.now() + 10 * 60_000
  let delay = 3_000

  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new SeedanceError('Aborted')
    await new Promise(r => setTimeout(r, delay))
    // Back off while queued so a cold start does not cost hundreds of polls.
    delay = Math.min(delay * 1.2, 10_000)

    const res = await fetch(`${BASE}/${ENDPOINT}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    })
    const data = await res.json().catch(() => null) as RunPodStatus | null
    if (!data) continue

    if (data.status === 'COMPLETED') {
      const videoUrl = videoUrlFrom(data.output)
      if (!videoUrl) {
        throw new SeedanceError(
          `Job completed with no video URL. Output shape: ${JSON.stringify(data.output).slice(0, 300)}`,
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
      throw new SeedanceError(
        `RunPod job ${data.status}: ${JSON.stringify(data.error ?? {}).slice(0, 300)}`,
      )
    }
  }

  throw new SeedanceError(`RunPod job ${jobId} did not finish within 10 minutes`)
}
