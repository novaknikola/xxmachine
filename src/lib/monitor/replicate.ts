import { editImage } from '@/lib/wavespeed'
import {
  VIDEO_BACKEND_LABELS,
  normalizeVideoBackend,
  resolveVideoBackend,
  type VideoBackend,
} from './video-backends'
import type { ImageModel, VideoTechnique } from './types'

export {
  VIDEO_BACKEND_LABELS,
  VIDEO_BACKEND_OPTIONS,
  normalizeVideoBackend,
  resolveVideoBackend,
  type VideoBackend,
} from './video-backends'

const IMAGE_MODEL = 'wavespeed-ai/z-image/turbo-lora'
const API_V2 = 'https://api.wavespeed.ai/api/v2'
const API_V3 = 'https://api.wavespeed.ai/api/v3'

export function normalizeImageModel(raw: unknown): ImageModel {
  return raw === 'seedream_edit' ? 'seedream_edit' : 'z_image'
}

function buildImagePrompt(opts: {
  scenePrompt: string
  triggerWord?: string | null
  basePromptStyle?: string | null
  /**
   * Seedream: images[] are character face refs only (no source reel frame).
   * Instruct a fresh photo from the scene prompt, identity from refs.
   */
  characterRefsOnly?: boolean
}): string {
  // Scene (body + cast + caption) before character style — style often says
  // "slim/fit" and washes out bust/glute size when it comes first.
  return [
    opts.triggerWord?.trim(),
    opts.characterRefsOnly
      ? [
          'Generate a NEW photograph from the scene description below.',
          'The attached images are character identity references only (face, hair, skin, piercings).',
          'Match that woman\'s identity; do NOT copy pose, framing, outfit, or background from the reference photos.',
          'Do NOT edit or composite an existing reel frame — invent the shot from the prompt.',
        ].join(' ')
      : null,
    opts.scenePrompt.trim(),
    opts.basePromptStyle?.trim(),
  ].filter(Boolean).join('\n\n')
}

function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY
  if (!key) throw new Error('WAVESPEED_API_KEY not configured')
  return key
}

async function pollV2(requestId: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${API_V2}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${wavespeedKey()}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs from Wavespeed')
      return outputs[0] as string
    }
    if (status === 'failed') throw new Error('Wavespeed failed: ' + JSON.stringify(data?.data?.error))
  }
  throw new Error('Wavespeed image timeout')
}

async function pollV3(requestId: string, signal: AbortSignal, label: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 5000))
    const res = await fetch(`${API_V3}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${wavespeedKey()}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error(`${label}: no video output`)
      return outputs[0] as string
    }
    if (status === 'failed') {
      throw new Error(`${label} failed: ` + JSON.stringify(data?.data?.error))
    }
  }
  throw new Error(`${label}: video timeout`)
}

export async function generateReplicaImage(opts: {
  scenePrompt: string
  loraUrl?: string | null
  loraScale?: number
  triggerWord?: string | null
  basePromptStyle?: string | null
}): Promise<string> {
  const key = wavespeedKey()
  const prompt = buildImagePrompt(opts)

  const payload: Record<string, unknown> = {
    prompt,
    size: '756*1344',
    enable_safety_checker: false,
  }
  if (opts.loraUrl) {
    payload.loras = [{ path: opts.loraUrl, scale: opts.loraScale ?? 0.8 }]
  }

  const initRes = await fetch(`${API_V2}/${IMAGE_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(initData.message ?? JSON.stringify(initData))
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error('No request ID from Wavespeed')

  return pollV2(requestId, AbortSignal.timeout(130_000))
}

/**
 * Seedream Edit — character face refs + detailed scene prompt → new keyframe.
 * No source reel thumbnail/frame is passed.
 */
export async function generateReplicaImageSeedream(opts: {
  scenePrompt: string
  referenceImageUrls: string[]
  triggerWord?: string | null
  basePromptStyle?: string | null
  resolution?: '1k' | '2k'
}): Promise<string> {
  const refs = opts.referenceImageUrls.map(u => u.trim()).filter(Boolean)
  if (!refs.length) {
    throw new Error('Seedream Edit needs at least one character face reference photo')
  }

  const urls = await editImage({
    imageUrls: refs,
    prompt: buildImagePrompt({ ...opts, characterRefsOnly: true }),
    size: '9:16',
    resolution: opts.resolution ?? '1k',
    apiKey: wavespeedKey(),
    signal: AbortSignal.timeout(600_000),
  })
  if (!urls[0]) throw new Error('Seedream Edit returned no image')
  return urls[0]
}

export interface ReplicaVideoInput {
  technique: VideoTechnique
  videoBackend?: VideoBackend
  imageUrl: string
  endImageUrl?: string | null
  sourceVideoUrl?: string | null
  motionPrompt?: string | null
  duration?: number | null
  loraUrl?: string | null
  loraScale?: number
  /** Seedance native audio (generate_audio). */
  generateAudio?: boolean
}

export interface ReplicaVideoResult {
  videoUrl: string
  /** Audit string: backend:modelPath */
  model: string
  backend: Exclude<VideoBackend, 'auto'>
  technique: VideoTechnique
}

/** Dispatches to the chosen / auto-resolved WaveSpeed video backend. */
export async function generateReplicaVideo(input: ReplicaVideoInput): Promise<ReplicaVideoResult> {
  const key = wavespeedKey()
  const choice = normalizeVideoBackend(input.videoBackend)
  const resolved = resolveVideoBackend(choice, input.technique)
  const label = VIDEO_BACKEND_LABELS[resolved.backend]

  if (resolved.useMultiShotQueue) {
    throw new Error('Multi-shot must run through the queue, not generateReplicaVideo')
  }
  if (resolved.needsSourceVideo && !input.sourceVideoUrl) {
    throw new Error(`${label} requires the source video`)
  }
  if (resolved.needsEndImage && !input.endImageUrl) {
    throw new Error(`${label} requires a generated end frame`)
  }
  if (resolved.needsLora && !input.loraUrl) {
    throw new Error(`${label} requires a character LoRA`)
  }

  const initRes = await fetch(`${API_V3}/${resolved.model}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resolved.buildPayload(input)),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(`${label} failed: ${initData.message ?? JSON.stringify(initData)}`)
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error(`No request ID from ${resolved.model}`)

  const videoUrl = await pollV3(requestId, AbortSignal.timeout(310_000), label)
  return {
    videoUrl,
    model: `${resolved.backend}:${resolved.model}`,
    backend: resolved.backend,
    technique: input.technique,
  }
}
