/**
 * alibaba/wan-3.0/reference-to-video via WaveSpeed — replaces a person in a
 * source video with the identity from a reference photo directly, in one
 * generative call. No scene-description prompt to write — the model reads the
 * reference video itself, which is why this pipeline (see wan-jobs.ts) has no
 * "classify" stage at all. That video is the source reel with its person
 * scrubbed out (wan-motion-reference.ts), never the raw reel: the model has no
 * reference weight, so a raw reel's person won over the images on anything they
 * did not show — tattoos, piercings, makeup.
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

/**
 * Built on the model's own documented instruction ("Replace woman in the video
 * with the one in the reference image…"), with each input's role named the way
 * the model addresses them (Image 1, Image 2, Video 1). Video 1's person is grey
 * and blurred by design, so it is named as motion only — otherwise the model
 * may copy that look too. Not a per-scene prompt: no scene description needed.
 */
export const WAN_MOTION_REFERENCE_PROMPT =
  'Replace the woman in Video 1 with the woman in Image 1 and Image 2 (the same person). ' +
  'Video 1 is a motion reference only: the woman in it is deliberately grey and blurred, so take her movement, ' +
  'pose and timing from it, together with the camera movement, framing and background — never her look. ' +
  'Her face, hair and skin come from Image 1; her outfit and how she looks in this scene come from Image 2. ' +
  'Remove text on screen, remove captions.'

/** Output resolution for every Replicator video (user choice 2026-09-29: 480p). */
export const WAN_RESOLUTION = '480p' as const

/** The model accepts up to 10 reference images. */
export const WAN_MAX_REFERENCE_IMAGES = 10

const POLL_ATTEMPTS = 360        // pollV3's own 5s interval × 360 = 30 min
const ABORT_MS = 1_800_000       // 30 min

export interface WanReferenceInput {
  /** Image 1 the character's reference photo (identity), Image 2 the approved scene still. */
  referenceImageUrls: string[]
  /** Video 1: the reel with its person scrubbed (buildMotionReference) — never the raw reel. */
  motionVideoUrl: string
  /** Defaults to WAN_MOTION_REFERENCE_PROMPT. */
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

/** The request body, exactly as sent — the API has no weight, strength or negative-prompt field. */
export function buildWanReferencePayload(input: WanReferenceInput) {
  return {
    prompt: input.prompt?.trim() || WAN_MOTION_REFERENCE_PROMPT,
    reference_images: input.referenceImageUrls.slice(0, WAN_MAX_REFERENCE_IMAGES),
    reference_videos: [input.motionVideoUrl],
    resolution: input.resolution ?? WAN_RESOLUTION,
    aspect_ratio: input.aspectRatio ?? '9:16',
    duration: input.duration ?? 5,
    enable_prompt_expansion: false,
    enable_audio: true,
  }
}

export async function generateWanReferenceVideo(
  input: WanReferenceInput,
  apiKey: string,
): Promise<WanReferenceResult> {
  const payload = buildWanReferencePayload(input)

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
