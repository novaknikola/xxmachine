/**
 * alibaba/wan-3.0/reference-to-video via WaveSpeed — replaces a person in a
 * source video with the identity from a reference photo directly, in one
 * generative call. No separate keyframe-compositing step (Seedream) and no
 * scene-description prompt to write — the model takes the raw reference
 * photo + raw source video and does the identity swap itself, which is why
 * this pipeline (see wan-jobs.ts) has no "classify" stage at all.
 *
 * Explicit user ask 2026-09-20, replacing bytedance/seedance-2.0/video-edit
 * for new Copy-Paste submissions from the Telegram bot — that model's
 * reference_images input is only documented as soft "style/character
 * guidance", not a hard identity lock, and was repeatedly observed keeping
 * the original video's face instead of the swap (see finishCopyPasteVideo's
 * comment history, confirmed live 2026-08-24 and 2026-09-15).
 */
import { API_V3, pollV3 } from './replicate'

export const WAN_MODEL = 'alibaba/wan-3.0/reference-to-video'

/** The model's own documented default instruction — deliberately not a
 * per-scene generated prompt, since the model reads the reference video
 * directly and needs no scene description. */
export const WAN_DEFAULT_PROMPT =
  'Replace woman in the video with the one in the reference image. Remove text on screen, remove captions.'

const POLL_ATTEMPTS = 360        // pollV3's own 5s interval × 360 = 30 min
const ABORT_MS = 1_800_000       // 30 min

export interface WanReferenceInput {
  referenceImageUrl: string
  referenceVideoUrl: string
  /** Defaults to WAN_DEFAULT_PROMPT. */
  prompt?: string
  resolution?: '480p' | '720p' | '1080p'
  /** e.g. '9:16', '16:9' — passed through as-is. */
  aspectRatio?: string
  /** 2–30s; the model caps total input+output at 30s, so keep this conservative for a long source clip. */
  duration?: number
}

export interface WanReferenceResult {
  videoUrl: string
  model: string
}

export async function generateWanReferenceVideo(
  input: WanReferenceInput,
  apiKey: string,
): Promise<WanReferenceResult> {
  const payload = {
    prompt: input.prompt?.trim() || WAN_DEFAULT_PROMPT,
    reference_images: [input.referenceImageUrl],
    reference_videos: [input.referenceVideoUrl],
    resolution: input.resolution ?? '720p',
    aspect_ratio: input.aspectRatio ?? '9:16',
    duration: input.duration ?? 5,
    enable_prompt_expansion: false,
    enable_audio: true,
  }

  const initRes = await fetch(`${API_V3}/${WAN_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(`Wan 3.0 failed: ${initData.message ?? JSON.stringify(initData)}`)
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error(`No request ID from ${WAN_MODEL}`)

  const videoUrl = await pollV3(
    requestId,
    apiKey,
    AbortSignal.timeout(ABORT_MS),
    'Wan 3.0',
    POLL_ATTEMPTS,
  )
  return { videoUrl, model: WAN_MODEL }
}
