/**
 * WaveSpeed Nano Banana Pro Edit client — used for BOTH the first-frame and
 * end-frame character stills, per this session's explicit ask (2026-09-17):
 * first frame is generated from the identity reference photo alone; the end
 * frame is generated from the identity reference photo PLUS the just-built
 * first frame (so wardrobe/scene continuity carries over, not just
 * identity). Same submit+poll pattern as editImage (Seedream v5.0 Pro Edit,
 * src/lib/wavespeed.ts) — Nano Banana Pro Edit is the same shape, just a
 * different model id and field set (see content-pipeline/apps-script/
 * WaveSpeed.gs's existing upscalePortrait for the field names this mirrors).
 */

const NANO_BANANA_EDIT_URL = 'https://api.wavespeed.ai/api/v3/google/nano-banana-pro/edit'
const RESULT_BASE = 'https://api.wavespeed.ai/api/v3/predictions'

const POLL_INTERVAL_MS = 3000
/** 200 x 3s = 10 min. Was 6 min, which gave up on two stills on 2026-09-25 —
 * and giving up abandons a prediction that may still finish (and bill) while
 * the queue retry submits a second one. */
const POLL_MAX_ATTEMPTS = 200
/** One hung connection must not stall the whole step. */
const REQUEST_TIMEOUT_MS = 30_000

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function pollNanoBananaResult(
  requestId: string,
  apiKey: string,
  signal: AbortSignal | undefined,
  pollIntervalMs: number,
): Promise<string[]> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    if (signal?.aborted) throw new Error('Request aborted')
    await new Promise(r => setTimeout(r, pollIntervalMs))

    let data: { data?: { status?: string; outputs?: string[]; error?: unknown }; status?: string; outputs?: string[]; error?: unknown } | null
    try {
      const res = await fetch(`${RESULT_BASE}/${requestId}/result`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      })
      data = await res.json()
    } catch (err) {
      // A dropped connection, a timeout or a non-JSON gateway page says nothing
      // about the prediction itself — keep polling rather than throw away a
      // paid render and resubmit. Only the caller's own abort ends it early.
      if (signal?.aborted) throw err
      console.warn('[nano-banana] poll request failed, retrying:', err instanceof Error ? err.message : err)
      continue
    }
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs returned')
      return outputs as string[]
    }
    if (status === 'failed' || status === 'cancelled' || status === 'timeout' || status === 'deleted') {
      throw new Error(`Nano Banana Pro edit ${status}: ` + JSON.stringify(data?.data?.error ?? data?.error))
    }
  }
  throw new Error('Timeout while polling Nano Banana Pro edit result')
}

export interface NanoBananaEditInput {
  /** Publicly reachable image URLs — WaveSpeed fetches these directly.
   * First frame: [referencePhoto]. End frame: [referencePhoto, firstFrameUrl]. */
  imageUrls: string[]
  prompt: string
  aspectRatio?: string
  resolution?: '1k' | '2k' | '4k'
  apiKey: string
  signal?: AbortSignal
  /** Test hook; production keeps the 3s default. */
  pollIntervalMs?: number
}

export async function editImageNanoBananaPro(input: NanoBananaEditInput): Promise<string[]> {
  const { imageUrls, prompt, aspectRatio = '9:16', resolution = '2k', apiKey, signal } = input
  if (!imageUrls.length) throw new Error('Nano Banana Pro edit requires at least one reference image')

  const body: Record<string, unknown> = {
    prompt,
    images: imageUrls,
    aspect_ratio: aspectRatio,
    resolution,
    output_format: 'jpeg',
    enable_base64_output: false,
    enable_sync_mode: false,
  }

  const initRes = await fetch(NANO_BANANA_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(signal, REQUEST_TIMEOUT_MS * 2),
  })
  const initData = await initRes.json().catch(() => null)
  if (!initRes.ok || (initData?.code && initData.code !== 200)) {
    throw new Error(
      `Nano Banana Pro submit failed (${initRes.status}): ${initData?.message ?? (initData ? JSON.stringify(initData) : 'non-JSON response')}`,
    )
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error('No request ID returned')

  return pollNanoBananaResult(requestId, apiKey, signal, input.pollIntervalMs ?? POLL_INTERVAL_MS)
}
