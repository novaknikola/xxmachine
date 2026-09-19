/**
 * Typed WaveSpeed Seedance 2.5 image-to-video client.
 *
 * Replaces kling-client.ts as the render step for @contentreplicatorbot.
 * Seedance's request shape is much smaller than Kling's — no cfg_scale,
 * shot_type, element_list, or multi_prompt. The `prompt` field carries a
 * motion-only, gapless timed description (built by buildSeedanceInput in
 * process-job.ts); the still image supplies everything about the scene/
 * character that would otherwise need re-describing.
 *
 * Docs: https://wavespeed.ai/docs/docs-api/bytedance/bytedance-seedance-2.5-image-to-video
 * Full field rules: D:\VScode\reels-analiza\docs\SEEDANCE-2.5-I2V.md
 */

export const WAVESPEED_API_V3 = 'https://api.wavespeed.ai/api/v3'

export const SEEDANCE_I2V_MODELS = {
  standard: 'bytedance/seedance-2.5/image-to-video',
  spicy: 'bytedance/seedance-2.5/image-to-video-spicy',
  turbo: 'bytedance/seedance-2.5/image-to-video-turbo',
} as const

export type SeedanceVariant = keyof typeof SEEDANCE_I2V_MODELS
export type SeedanceResolution = '480p' | '720p' | '1080p' | '4k'

export const SEEDANCE_DURATION_MIN = 4
export const SEEDANCE_DURATION_MAX = 30
export const SEEDANCE_SPICY_DURATION_MAX = 15
export const SEEDANCE_DURATION_DEFAULT = 5
export const SEEDANCE_RESOLUTION_DEFAULT: SeedanceResolution = '480p'
export const SEEDANCE_GENERATE_AUDIO_DEFAULT = true

export interface SeedanceI2VInput {
  variant: SeedanceVariant
  image: string
  /** Motion-only, gapless timed prompt — see SEEDANCE-2.5-I2V.md. Required
   * on the standard/turbo endpoints, optional on spicy. */
  prompt?: string
  /** Integer, 4-30s (spicy caps at 15s). Default 5. */
  duration?: number
  resolution?: SeedanceResolution
  generate_audio?: boolean
  /** Optional end-frame still — a Seedream Edit of the same still, never an
   * independently generated image (confirmed failure mode if it isn't). */
  last_image?: string
  /** Spicy endpoint only. */
  seed?: number
}

export interface SeedanceImageMeta {
  contentType?: string | null
  byteLength?: number | null
  width?: number | null
  height?: number | null
}

export class SeedancePayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedancePayloadError'
  }
}

export function seedanceI2VEndpoint(variant: SeedanceVariant): string {
  const model = SEEDANCE_I2V_MODELS[variant]
  if (!model) throw new SeedancePayloadError(`Unknown Seedance variant: ${String(variant)}`)
  return `${WAVESPEED_API_V3}/${model}`
}

export function clampSeedanceDuration(
  seconds: number | null | undefined,
  variant: SeedanceVariant,
): number {
  const max = variant === 'spicy' ? SEEDANCE_SPICY_DURATION_MAX : SEEDANCE_DURATION_MAX
  if (seconds == null || !Number.isFinite(Number(seconds))) return SEEDANCE_DURATION_DEFAULT
  return Math.min(max, Math.max(SEEDANCE_DURATION_MIN, Math.round(Number(seconds))))
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

export function assertSeedanceImageConstraints(meta: SeedanceImageMeta): void {
  if (meta.contentType) {
    const type = meta.contentType.split(';')[0].trim().toLowerCase()
    if (type && !ALLOWED_IMAGE_TYPES.has(type)) {
      throw new SeedancePayloadError(
        `Seedance image must be jpg/png/webp (got ${meta.contentType})`,
      )
    }
  }
}

/**
 * Build the exact JSON body posted to WaveSpeed. Only documented fields —
 * never aspect_ratio/size/width/height (aspect follows `image`), never
 * images[] (that's Seedream Edit, not Seedance I2V), never a re-description
 * of what's already visible on the still.
 */
export function buildSeedanceI2VPayload(
  input: SeedanceI2VInput,
  imageMeta?: SeedanceImageMeta,
): Record<string, unknown> {
  if (!input.image?.trim()) {
    throw new SeedancePayloadError('Seedance image URL is required')
  }
  if (imageMeta) assertSeedanceImageConstraints(imageMeta)

  const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim().length > 0
  if (!hasPrompt && input.variant !== 'spicy') {
    throw new SeedancePayloadError('prompt is required for this Seedance endpoint')
  }

  const payload: Record<string, unknown> = {
    image: input.image.trim(),
    duration: clampSeedanceDuration(input.duration, input.variant),
    resolution: input.resolution ?? SEEDANCE_RESOLUTION_DEFAULT,
    generate_audio: input.generate_audio ?? SEEDANCE_GENERATE_AUDIO_DEFAULT,
  }

  if (hasPrompt) payload.prompt = input.prompt!.trim()
  if (input.last_image) payload.last_image = input.last_image
  if (input.variant === 'spicy' && input.seed != null) payload.seed = input.seed

  return payload
}

const POLL_INTERVAL_MS = 5_000
// Match Kling's budget philosophy in this pipeline (see kling-client.ts) —
// an early abort just discards a render WaveSpeed still bills for.
const SEEDANCE_POLL_ATTEMPTS = 540 // 540 x 5s = 45 min
const SEEDANCE_ABORT_MS = 2_700_000

async function pollSeedanceResult(
  requestId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  for (let i = 0; i < SEEDANCE_POLL_ATTEMPTS; i++) {
    if (signal.aborted) throw new Error('Seedance poll aborted')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    let data: any
    try {
      const res = await fetch(`${WAVESPEED_API_V3}/predictions/${requestId}/result`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      })
      data = await res.json()
    } catch (err) {
      if (signal.aborted) throw err
      console.warn('[kling-recreate] seedance poll request failed, retrying:', err instanceof Error ? err.message : err)
      continue
    }
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('Seedance 2.5: no video output')
      return outputs[0] as string
    }
    if (status === 'failed' || status === 'cancelled' || status === 'timeout' || status === 'deleted') {
      throw new Error(`Seedance 2.5 ${status}: ${JSON.stringify(data?.data?.error ?? data?.error ?? data)}`)
    }
  }
  throw new Error('Seedance 2.5: video timeout')
}

export interface SeedanceI2VResult {
  videoUrl: string
  model: string
  requestId: string
  payload: Record<string, unknown>
}

export async function generateSeedanceI2V(
  input: SeedanceI2VInput,
  apiKey: string,
  opts?: {
    imageMeta?: SeedanceImageMeta
    existingRequestId?: string | null
    onSubmitted?: (requestId: string, payload: Record<string, unknown>) => Promise<void>
  },
): Promise<SeedanceI2VResult> {
  if (!apiKey) throw new Error('WaveSpeed API key is required')
  const payload = buildSeedanceI2VPayload(input, opts?.imageMeta)
  const model = SEEDANCE_I2V_MODELS[input.variant]
  const signal = AbortSignal.timeout(SEEDANCE_ABORT_MS)

  let requestId = opts?.existingRequestId ?? null
  if (!requestId) {
    const initRes = await fetch(seedanceI2VEndpoint(input.variant), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })
    const initData = await initRes.json().catch(() => null)
    if (!initRes.ok) {
      throw new Error(`Seedance 2.5 submit failed (${initRes.status}): ${initData?.message ?? JSON.stringify(initData)}`)
    }
    if (initData?.code && initData.code !== 200) {
      throw new Error(`Seedance 2.5 failed: ${initData.message ?? JSON.stringify(initData)}`)
    }
    requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error(`No request ID from ${model}`)
    await opts?.onSubmitted?.(requestId, payload)
  }

  const videoUrl = await pollSeedanceResult(requestId, apiKey, signal)
  return { videoUrl, model, requestId, payload }
}
