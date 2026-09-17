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

async function pollNanoBananaResult(requestId: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const maxAttempts = 120 // 120 x 3s = 6 min — image edit, not a video render
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('Request aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${RESULT_BASE}/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs returned')
      return outputs as string[]
    }
    if (status === 'failed') {
      throw new Error('Nano Banana Pro edit failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
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
    signal,
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(initData.message ?? JSON.stringify(initData))
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error('No request ID returned')

  return pollNanoBananaResult(requestId, apiKey, signal)
}
