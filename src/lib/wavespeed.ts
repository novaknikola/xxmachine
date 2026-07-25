export const DIMENSION_MAP: Record<string, string> = {
  '1:1': '1024*1024',
  '4:3': '1152*864',
  '3:4': '864*1152',
  '16:9': '1344*756',
  '9:16': '756*1344',
  '2:3': '768*1152',
  '3:2': '1152*768',
}

const MODEL = 'wavespeed-ai/z-image/turbo-lora'
const API_BASE = 'https://api.wavespeed.ai/api/v2'

export function convertLoraUrl(url: string, hfToken: string): string {
  if (url.includes('huggingface.co')) {
    return url.replace('/blob/', '/resolve/').split('?')[0] + '?token=' + hfToken
  }
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (!match) return url
    return `https://drive.google.com/uc?export=download&confirm=t&id=${match[1]}`
  }
  return url
}

async function pollResult(requestId: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  for (let i = 0; i < 40; i++) {
    if (signal?.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${API_BASE}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs')
      return outputs as string[]
    }
    if (status === 'failed') {
      throw new Error('Generation failed: ' + (data?.data?.error ?? data?.error ?? 'unknown'))
    }
  }
  throw new Error('Timeout after 40 polling attempts')
}

export interface GenerateImageInput {
  prompt: string
  dimension: string
  loraUrl?: string | null
  loraScale?: number
  apiKey: string
  hfToken?: string
  signal?: AbortSignal
}

export async function generateImage(input: GenerateImageInput): Promise<string[]> {
  const { prompt, dimension, loraUrl, loraScale, apiKey, hfToken = '', signal } = input
  const size = DIMENSION_MAP[dimension] ?? '756*1344'

  const payload: Record<string, unknown> = {
    prompt,
    size,
    enable_safety_checker: false,
  }
  if (loraUrl) {
    payload.loras = [{ path: convertLoraUrl(loraUrl, hfToken), scale: loraScale ?? 0.8 }]
  }

  const initRes = await fetch(`${API_BASE}/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(initData.message ?? JSON.stringify(initData))
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error('No request ID returned')

  return pollResult(requestId, apiKey, signal)
}

// ─── Image editing (Seedream v5 Pro Edit) ───────────────────────────────────

const SEEDREAM_EDIT_URL = 'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-pro/edit'
const EDIT_RESULT_BASE = 'https://api.wavespeed.ai/api/v3/predictions'

export {
  getCarouselVariantPrompts,
  CAROUSEL_PRESETS,
  DEFAULT_CAROUSEL_PRESET_ID,
  CAROUSEL_GROK_HINT,
  CAROUSEL_ANGLE_PROMPTS,
} from './carousel-presets'

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function toAspectRatio(sizeRaw?: string): string | undefined {
  if (!sizeRaw) return undefined
  if (/^\d+:\d+$/.test(sizeRaw)) return sizeRaw
  if (sizeRaw.includes('*')) {
    const [w, h] = sizeRaw.split('*').map(Number)
    if (w && h) {
      const d = gcd(w, h)
      return `${w / d}:${h / d}`
    }
  }
  return undefined
}

async function pollEditResult(requestId: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const maxAttempts = 120
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('Request aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${EDIT_RESULT_BASE}/${requestId}/result`, {
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
      throw new Error('Edit failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
    }
  }
  throw new Error('Timeout while polling image-edit result')
}

export type SeedreamResolution = '1k' | '2k'

/** Seedream v5.0 Pro Edit accepts 1–10 images per request. */
export const SEEDREAM_MAX_IMAGES = 10

export interface EditImageInput {
  /** Publicly reachable image URLs — WaveSpeed fetches these directly, no separate upload step needed. */
  imageUrls: string[]
  prompt: string
  /** Ratio key (e.g. '9:16') or raw 'W*H' string. */
  size?: string
  /** Seedream output resolution — default 1k. */
  resolution?: SeedreamResolution
  apiKey: string
  signal?: AbortSignal
}

export async function editImage(input: EditImageInput): Promise<string[]> {
  const { imageUrls, prompt, size, resolution = '1k', apiKey, signal } = input

  const body: Record<string, unknown> = {
    images: imageUrls.slice(0, SEEDREAM_MAX_IMAGES),
    prompt,
    resolution,
  }
  const aspectRatio = toAspectRatio(size)
  if (aspectRatio) body.aspect_ratio = aspectRatio

  const initRes = await fetch(SEEDREAM_EDIT_URL, {
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

  return pollEditResult(requestId, apiKey, signal)
}
