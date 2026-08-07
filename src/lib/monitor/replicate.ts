import { buildSeedancePayload, SEEDANCE_MODEL, type SeedanceCallInput } from './seedance'
import { editImage } from '@/lib/wavespeed'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import type { SourceAspectRatio } from './analyze'

const API_V3 = 'https://api.wavespeed.ai/api/v3'
const SEEDREAM_KEYFRAME_MODEL = 'seedream-v5.0-pro-edit'

const POLL_INTERVAL_MS = 5_000
/**
 * Both calls run inside a generation_queue worker, not an HTTP request, so these
 * are bounded by how long the model actually takes rather than by nginx's
 * proxy_read_timeout. Seedream's own poll (pollEditResult in wavespeed.ts) caps
 * at ~360s, so the signal here is deliberately looser — otherwise it would abort
 * the call before that poll can report a real failure.
 *
 * Seedance is now video-edit (restyles the real source clip) rather than
 * image-to-video (synthesized from a still) — it processes actual video frames,
 * not just one image, so it runs noticeably longer than the old model. The
 * first live run under this model was still going at the old 12-minute cap
 * with no error, so this is widened rather than guessed down.
 */
const SEEDANCE_POLL_ATTEMPTS = 240            // 240 × 5s = 20 min
const SEEDANCE_ABORT_MS = 1_220_000           // ~20.3 min
const SEEDREAM_ABORT_MS = 400_000

async function pollV3(
  requestId: string,
  apiKey: string,
  signal: AbortSignal,
  label: string,
  maxAttempts = 60,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(`${API_V3}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
  /** Frame of the source reel used as scene/pose/background reference. */
  sourceFrameUrl: string
  /** User's uploaded photo (identity reference). */
  referenceImageUrl: string
  /** renderKeyframeEditPrompt / renderEndKeyframeEditPrompt output. */
  prompt: string
  aspectRatio: SourceAspectRatio
  itemId: string
  /**
   * Start keyframe, passed as a third reference when rendering the end frame so
   * both ends agree on wardrobe/hair/skin. Omitted for the start frame itself.
   */
  matchImageUrl?: string | null
  /** Storage basename — keeps the two keyframes from overwriting each other. */
  slot?: 'keyframe' | 'keyframe-end'
}

export interface KeyframeResult {
  imageUrl: string
  /** Audit string: model path. */
  model: string
}

/** Composites the reference photo's identity onto a source frame via Seedream v5 Pro Edit. */
export async function generateCopyPasteKeyframe(input: KeyframeInput, apiKey: string): Promise<KeyframeResult> {
  const size = input.aspectRatio === 'other' ? '9:16' : input.aspectRatio
  const imageUrls = [input.sourceFrameUrl, input.referenceImageUrl]
  if (input.matchImageUrl) imageUrls.push(input.matchImageUrl)

  const outputs = await editImage({
    imageUrls,
    prompt: input.prompt,
    size,
    resolution: '1k',
    apiKey,
    signal: AbortSignal.timeout(SEEDREAM_ABORT_MS),
  })
  if (!outputs.length) throw new Error('Seedream Edit: no keyframe output')

  const imageUrl = await uploadImageFromUrl(
    outputs[0],
    `monitor/${input.itemId}/${input.slot ?? 'keyframe'}.jpg`,
  )
  return { imageUrl, model: SEEDREAM_KEYFRAME_MODEL }
}

/** Edits the original source clip in place, guided by the Seedream keyframe(s) and the rendered scene prompt. */
export async function generateSeedanceVideo(input: SeedanceCallInput, apiKey: string): Promise<SeedanceVideoResult> {
  const payload = buildSeedancePayload(input)

  const initRes = await fetch(`${API_V3}/${SEEDANCE_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

  const videoUrl = await pollV3(
    requestId,
    apiKey,
    AbortSignal.timeout(SEEDANCE_ABORT_MS),
    'Seedance',
    SEEDANCE_POLL_ATTEMPTS,
  )
  return { videoUrl, model: SEEDANCE_MODEL }
}
