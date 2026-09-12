/**
 * Typed WaveSpeed Kling 3.0 image-to-video client.
 *
 * Quality is the model path — there is no resolution field on any Kling 3.0
 * i2v endpoint. Pro / Std / 4K share the same request body.
 *
 * Docs:
 * - https://wavespeed.ai/docs/docs-api/kwaivgi/kwaivgi-kling-v3.0-pro-image-to-video
 * - https://wavespeed.ai/docs/docs-api/kwaivgi/kwaivgi-kling-v3.0-std-image-to-video
 * - https://wavespeed.ai/docs/docs-api/kwaivgi/kwaivgi-kling-v3.0-4k-image-to-video
 */

export const WAVESPEED_API_V3 = 'https://api.wavespeed.ai/api/v3'

export const KLING_I2V_MODELS = {
  std: 'kwaivgi/kling-v3.0-std/image-to-video',
  pro: 'kwaivgi/kling-v3.0-pro/image-to-video',
  '4k': 'kwaivgi/kling-v3.0-4k/image-to-video',
} as const

export type KlingVariant = keyof typeof KLING_I2V_MODELS
export type KlingShotType = 'customize' | 'intelligence'

export const KLING_DURATION_MIN = 3
export const KLING_DURATION_MAX = 15
export const KLING_DURATION_DEFAULT = 5
export const KLING_CFG_DEFAULT = 0.5
export const KLING_SOUND_DEFAULT = true
export const KLING_SHOT_TYPE_DEFAULT: KlingShotType = 'customize'

export const KLING_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const KLING_IMAGE_MIN_SIDE = 300
export const KLING_IMAGE_MAX_ASPECT = 2.5
export const KLING_MULTI_PROMPT_MAX = 6
export const KLING_ELEMENT_LIST_MAX = 3

export interface KlingMultiPromptItem {
  prompt: string
  duration?: number
}

export interface KlingI2VInput {
  variant: KlingVariant
  image: string
  /** Mutually exclusive with multi_prompt — WaveSpeed requires exactly one. */
  prompt?: string
  /** Mutually exclusive with prompt. 0–6 multi-shot beats. Incompatible with end_image. */
  multi_prompt?: KlingMultiPromptItem[]
  negative_prompt?: string
  /** Incompatible with multi_prompt / multi-shot. */
  end_image?: string
  /** Integer 3–15. Default 5. */
  duration?: number
  /** 0–1. Default 0.5. */
  cfg_scale?: number
  /** Product default is on (WaveSpeed's own default is off). */
  sound?: boolean
  shot_type?: KlingShotType
  /** 0–3 Kling element IDs. */
  element_list?: string[]
}

export interface KlingImageMeta {
  contentType?: string | null
  byteLength?: number | null
  width?: number | null
  height?: number | null
}

export class KlingPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KlingPayloadError'
  }
}

export function klingI2VEndpoint(variant: KlingVariant): string {
  const model = KLING_I2V_MODELS[variant]
  if (!model) throw new KlingPayloadError(`Unknown Kling variant: ${String(variant)}`)
  return `${WAVESPEED_API_V3}/${model}`
}

export function clampKlingDuration(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(Number(seconds))) return KLING_DURATION_DEFAULT
  return Math.min(KLING_DURATION_MAX, Math.max(KLING_DURATION_MIN, Math.round(Number(seconds))))
}

export function clampKlingCfg(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(Number(value))) return KLING_CFG_DEFAULT
  return Math.min(1, Math.max(0, Number(value)))
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])

export function assertKlingImageConstraints(meta: KlingImageMeta): void {
  if (meta.contentType) {
    const type = meta.contentType.split(';')[0].trim().toLowerCase()
    if (type && !ALLOWED_IMAGE_TYPES.has(type) && type !== 'image/jpg') {
      throw new KlingPayloadError(
        `Kling image must be jpg/jpeg/png (got ${meta.contentType})`,
      )
    }
  }
  if (meta.byteLength != null && meta.byteLength > KLING_IMAGE_MAX_BYTES) {
    throw new KlingPayloadError(
      `Kling image must be ≤10MB (got ${meta.byteLength} bytes)`,
    )
  }
  if (meta.width != null && meta.height != null) {
    if (meta.width < KLING_IMAGE_MIN_SIDE || meta.height < KLING_IMAGE_MIN_SIDE) {
      throw new KlingPayloadError(
        `Kling image must be at least ${KLING_IMAGE_MIN_SIDE}px on each side (got ${meta.width}×${meta.height})`,
      )
    }
    const aspect = meta.width / meta.height
    if (aspect < 1 / KLING_IMAGE_MAX_ASPECT || aspect > KLING_IMAGE_MAX_ASPECT) {
      throw new KlingPayloadError(
        `Kling image aspect must be between 1:2.5 and 2.5:1 (got ${meta.width}×${meta.height})`,
      )
    }
  }
}

export function imageLooksLikeKlingFormat(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase()
    return /\.(jpe?g|png)$/.test(path)
  } catch {
    return /\.(jpe?g|png)(\?|$)/i.test(url)
  }
}

/**
 * Build the exact JSON body posted to WaveSpeed. Every documented field the
 * caller supplied is included — nothing is silently dropped. Defaults are
 * applied so the persisted payload matches what we intend to send.
 */
export function buildKlingI2VPayload(
  input: KlingI2VInput,
  imageMeta?: KlingImageMeta,
): Record<string, unknown> {
  if (!input.image?.trim()) {
    throw new KlingPayloadError('Kling image URL is required')
  }
  if (imageMeta) assertKlingImageConstraints(imageMeta)

  const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim().length > 0
  const multi = (input.multi_prompt ?? []).filter(item => item?.prompt?.trim())
  const hasMulti = multi.length > 0

  if (hasPrompt && hasMulti) {
    throw new KlingPayloadError('Provide prompt or multi_prompt, not both')
  }
  if (!hasPrompt && !hasMulti) {
    throw new KlingPayloadError('Either prompt or multi_prompt must be provided')
  }
  if (multi.length > KLING_MULTI_PROMPT_MAX) {
    throw new KlingPayloadError(`multi_prompt accepts at most ${KLING_MULTI_PROMPT_MAX} items`)
  }
  if (input.end_image && hasMulti) {
    throw new KlingPayloadError('end_image is incompatible with multi_prompt / multi-shot')
  }

  const payload: Record<string, unknown> = {
    image: input.image.trim(),
    duration: clampKlingDuration(input.duration),
    cfg_scale: clampKlingCfg(input.cfg_scale),
    sound: input.sound ?? KLING_SOUND_DEFAULT,
    shot_type: input.shot_type ?? KLING_SHOT_TYPE_DEFAULT,
  }

  if (hasPrompt) payload.prompt = input.prompt!.trim()
  if (hasMulti) {
    payload.multi_prompt = multi.map(item => {
      const shot: Record<string, unknown> = { prompt: item.prompt.trim() }
      if (item.duration != null) shot.duration = clampKlingDuration(item.duration)
      return shot
    })
  }
  if (input.negative_prompt != null) payload.negative_prompt = input.negative_prompt
  if (input.end_image) payload.end_image = input.end_image
  if (input.element_list) {
    if (input.element_list.length > KLING_ELEMENT_LIST_MAX) {
      throw new KlingPayloadError(`element_list accepts at most ${KLING_ELEMENT_LIST_MAX} IDs`)
    }
    payload.element_list = [...input.element_list]
  }

  return payload
}

const POLL_INTERVAL_MS = 5_000
const KLING_POLL_ATTEMPTS = 360 // 360 × 5s = 30 min
const KLING_ABORT_MS = 1_800_000

async function pollKlingResult(
  requestId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  for (let i = 0; i < KLING_POLL_ATTEMPTS; i++) {
    if (signal.aborted) throw new Error('Kling poll aborted')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(`${WAVESPEED_API_V3}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('Kling 3.0: no video output')
      return outputs[0] as string
    }
    if (status === 'failed' || status === 'cancelled' || status === 'timeout' || status === 'deleted') {
      throw new Error(`Kling 3.0 ${status}: ${JSON.stringify(data?.data?.error ?? data?.error ?? data)}`)
    }
  }
  throw new Error('Kling 3.0: video timeout')
}

export interface KlingI2VResult {
  videoUrl: string
  model: string
  requestId: string
  payload: Record<string, unknown>
}

export async function generateKlingI2V(
  input: KlingI2VInput,
  apiKey: string,
  opts?: {
    imageMeta?: KlingImageMeta
    existingRequestId?: string | null
    onSubmitted?: (requestId: string, payload: Record<string, unknown>) => Promise<void>
  },
): Promise<KlingI2VResult> {
  if (!apiKey) throw new Error('WaveSpeed API key is required')
  const payload = buildKlingI2VPayload(input, opts?.imageMeta)
  const model = KLING_I2V_MODELS[input.variant]
  const signal = AbortSignal.timeout(KLING_ABORT_MS)

  let requestId = opts?.existingRequestId ?? null
  if (!requestId) {
    const initRes = await fetch(klingI2VEndpoint(input.variant), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })
    const initData = await initRes.json()
    if (initData.code && initData.code !== 200) {
      throw new Error(`Kling 3.0 failed: ${initData.message ?? JSON.stringify(initData)}`)
    }
    requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error(`No request ID from ${model}`)
    await opts?.onSubmitted?.(requestId, payload)
  }

  const videoUrl = await pollKlingResult(requestId, apiKey, signal)
  return { videoUrl, model, requestId, payload }
}
