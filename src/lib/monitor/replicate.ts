import { getTechnique } from './techniques'
import type { VideoTechnique } from './types'

const IMAGE_MODEL = 'wavespeed-ai/z-image/turbo-lora'
const API_V2 = 'https://api.wavespeed.ai/api/v2'
const API_V3 = 'https://api.wavespeed.ai/api/v3'

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

  const parts = [
    opts.triggerWord?.trim(),
    opts.basePromptStyle?.trim(),
    opts.scenePrompt.trim(),
  ].filter(Boolean)

  const payload: Record<string, unknown> = {
    prompt: parts.join(', '),
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

export interface ReplicaVideoInput {
  technique: VideoTechnique
  imageUrl: string
  endImageUrl?: string | null
  sourceVideoUrl?: string | null
  motionPrompt?: string | null
  duration?: number | null
}

export interface ReplicaVideoResult {
  videoUrl: string
  /** The endpoint that produced the clip, recorded for auditing routing decisions. */
  model: string
  technique: VideoTechnique
}

/** Dispatches to whichever model the detected technique calls for. */
export async function generateReplicaVideo(input: ReplicaVideoInput): Promise<ReplicaVideoResult> {
  const key = wavespeedKey()

  const spec = getTechnique(input.technique)
  if (!spec.model || !spec.buildPayload) {
    throw new Error(spec.reviewReason ?? `Technique ${input.technique} is not executable`)
  }
  if (spec.needsSourceVideo && !input.sourceVideoUrl) {
    throw new Error(`${spec.label} requires the source video, which is unavailable`)
  }
  if (spec.needsEndImage && !input.endImageUrl) {
    throw new Error(`${spec.label} requires a generated end frame`)
  }

  const initRes = await fetch(`${API_V3}/${spec.model}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(spec.buildPayload(input)),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(`${spec.label} failed: ${initData.message ?? JSON.stringify(initData)}`)
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error(`No request ID from ${spec.model}`)

  const videoUrl = await pollV3(requestId, AbortSignal.timeout(310_000), spec.label)
  return { videoUrl, model: spec.model, technique: spec.id }
}
