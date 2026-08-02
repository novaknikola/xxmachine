import { buildSeedancePayload, SEEDANCE_MODEL, type SeedanceCallInput } from './seedance'
import { editImage } from '@/lib/wavespeed'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import type { SourceAspectRatio } from './analyze'

const API_V3 = 'https://api.wavespeed.ai/api/v3'
const SEEDREAM_KEYFRAME_MODEL = 'seedream-v5.0-pro-edit'

export function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY
  if (!key) throw new Error('WAVESPEED_API_KEY not configured')
  return key
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

export interface SeedanceVideoResult {
  videoUrl: string
  /** Audit string: model path. */
  model: string
}

export interface KeyframeInput {
  /** Frame 0 of the source reel (scene/pose/background reference). */
  sourceFrameUrl: string
  /** User's uploaded photo (identity reference). */
  referenceImageUrl: string
  /** renderKeyframeEditPrompt(spec) output. */
  prompt: string
  aspectRatio: SourceAspectRatio
  itemId: string
}

export interface KeyframeResult {
  imageUrl: string
  /** Audit string: model path. */
  model: string
}

/** Composites the reference photo's identity onto the source frame via Seedream v5 Pro Edit. */
export async function generateCopyPasteKeyframe(input: KeyframeInput): Promise<KeyframeResult> {
  const apiKey = wavespeedKey()
  const size = input.aspectRatio === 'other' ? '9:16' : input.aspectRatio

  const outputs = await editImage({
    imageUrls: [input.sourceFrameUrl, input.referenceImageUrl],
    prompt: input.prompt,
    size,
    resolution: '1k',
    apiKey,
    signal: AbortSignal.timeout(180_000),
  })
  if (!outputs.length) throw new Error('Seedream Edit: no keyframe output')

  const imageUrl = await uploadImageFromUrl(outputs[0], `monitor/${input.itemId}/keyframe.jpg`)
  return { imageUrl, model: SEEDREAM_KEYFRAME_MODEL }
}

/** Single path: reference photo as image, rendered scene JSON as prompt, straight to Seedance i2v. */
export async function generateSeedanceVideo(input: SeedanceCallInput): Promise<SeedanceVideoResult> {
  const key = wavespeedKey()
  const payload = buildSeedancePayload(input)

  const initRes = await fetch(`${API_V3}/${SEEDANCE_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(`Seedance failed: ${initData.message ?? JSON.stringify(initData)}`)
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error(`No request ID from ${SEEDANCE_MODEL}`)

  const videoUrl = await pollV3(requestId, AbortSignal.timeout(310_000), 'Seedance')
  return { videoUrl, model: SEEDANCE_MODEL }
}
