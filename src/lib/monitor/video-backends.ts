import type { VideoTechnique } from './types'

/**
 * Executable video backends on WaveSpeed.
 * Technique = what the shot needs; backend = which API runs it.
 */
export type VideoBackend =
  | 'auto'
  | 'kling_mc'
  | 'wan_i2v'
  | 'seedance_i2v'
  | 'seedance_i2v_turbo'
  | 'ltx_i2v'
  | 'ltx_i2v_lora'

export const VIDEO_BACKEND_LABELS: Record<VideoBackend, string> = {
  auto: 'Auto (by technique)',
  kling_mc: 'Kling motion-control',
  wan_i2v: 'Wan 2.7 I2V',
  seedance_i2v: 'Seedance 2.0 I2V',
  seedance_i2v_turbo: 'Seedance 2.0 Turbo',
  ltx_i2v: 'LTX 2.3 I2V',
  ltx_i2v_lora: 'LTX 2.3 I2V + LoRA',
}

const KLING_MC = 'kwaivgi/kling-v2.6-std/motion-control'
const WAN_I2V = 'alibaba/wan-2.7/image-to-video'
const SEEDANCE_I2V = 'bytedance/seedance-2.0/image-to-video'
const SEEDANCE_TURBO = 'bytedance/seedance-2.0/image-to-video-turbo'
const LTX_I2V = 'wavespeed-ai/ltx-2.3/image-to-video'
const LTX_I2V_LORA = 'wavespeed-ai/ltx-2.3/image-to-video-lora'

export interface VideoBackendInput {
  imageUrl: string
  endImageUrl?: string | null
  sourceVideoUrl?: string | null
  motionPrompt?: string | null
  duration?: number | null
  loraUrl?: string | null
  loraScale?: number
}

export interface ResolvedVideoBackend {
  backend: Exclude<VideoBackend, 'auto'>
  model: string
  /** multi_shot queue path still uses Kling segments today. */
  useMultiShotQueue: boolean
  needsSourceVideo: boolean
  needsEndImage: boolean
  needsMotionPrompt: boolean
  needsLora: boolean
  buildPayload: (input: VideoBackendInput) => Record<string, unknown>
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function seedanceDuration(duration?: number | null): number {
  if (!duration || !Number.isFinite(duration)) return 5
  return clamp(Math.round(duration), 4, 15)
}

function ltxDuration(duration?: number | null): number {
  if (!duration || !Number.isFinite(duration)) return 5
  return clamp(Math.round(duration), 5, 20)
}

function wanDuration(duration?: number | null): number {
  if (!duration || duration <= 7) return 5
  return 10
}

function motionPromptOf(input: VideoBackendInput): string {
  return (input.motionPrompt ?? '').trim() || 'natural motion, cinematic, vertical phone video'
}

export function normalizeVideoBackend(raw: unknown): VideoBackend {
  const s = typeof raw === 'string' ? raw : ''
  if (
    s === 'kling_mc' || s === 'wan_i2v' || s === 'seedance_i2v' ||
    s === 'seedance_i2v_turbo' || s === 'ltx_i2v' || s === 'ltx_i2v_lora' || s === 'auto'
  ) return s
  return 'auto'
}

/** Technique → Auto backend. */
export function defaultBackendForTechnique(technique: VideoTechnique): Exclude<VideoBackend, 'auto'> {
  switch (technique) {
    case 'motion_transfer':
    case 'multi_shot':
      return 'kling_mc'
    case 'first_last_frame':
    case 'image_to_video':
    case 'extend':
      return 'seedance_i2v'
    default:
      return 'seedance_i2v'
  }
}

export function resolveVideoBackend(
  choice: VideoBackend,
  technique: VideoTechnique,
): ResolvedVideoBackend {
  const backend = choice === 'auto' ? defaultBackendForTechnique(technique) : choice

  if (technique === 'multi_shot' && (choice === 'auto' || choice === 'kling_mc')) {
    return {
      backend: 'kling_mc',
      model: KLING_MC,
      useMultiShotQueue: true,
      needsSourceVideo: true,
      needsEndImage: false,
      needsMotionPrompt: false,
      needsLora: false,
      buildPayload: () => ({}),
    }
  }

  switch (backend) {
    case 'kling_mc':
      return {
        backend,
        model: KLING_MC,
        useMultiShotQueue: false,
        needsSourceVideo: true,
        needsEndImage: false,
        needsMotionPrompt: false,
        needsLora: false,
        buildPayload: input => ({
          image: input.imageUrl,
          video: input.sourceVideoUrl,
          character_orientation: 'image',
        }),
      }

    case 'wan_i2v':
      return {
        backend,
        model: WAN_I2V,
        useMultiShotQueue: false,
        needsSourceVideo: false,
        needsEndImage: technique === 'first_last_frame',
        needsMotionPrompt: true,
        needsLora: false,
        buildPayload: input => {
          const body: Record<string, unknown> = {
            image: input.imageUrl,
            prompt: motionPromptOf(input),
            resolution: '720p',
            duration: wanDuration(input.duration),
          }
          if (input.endImageUrl) body.last_image = input.endImageUrl
          return body
        },
      }

    case 'seedance_i2v':
    case 'seedance_i2v_turbo':
      return {
        backend,
        model: backend === 'seedance_i2v_turbo' ? SEEDANCE_TURBO : SEEDANCE_I2V,
        useMultiShotQueue: false,
        needsSourceVideo: false,
        needsEndImage: technique === 'first_last_frame',
        needsMotionPrompt: true,
        needsLora: false,
        buildPayload: input => {
          const body: Record<string, unknown> = {
            image: input.imageUrl,
            prompt: motionPromptOf(input),
            aspect_ratio: '9:16',
            resolution: '720p',
            duration: seedanceDuration(input.duration),
            generate_audio: false,
            enable_web_search: false,
          }
          if (input.endImageUrl) body.last_image = input.endImageUrl
          return body
        },
      }

    case 'ltx_i2v':
      return {
        backend,
        model: LTX_I2V,
        useMultiShotQueue: false,
        needsSourceVideo: false,
        needsEndImage: false,
        needsMotionPrompt: true,
        needsLora: false,
        buildPayload: input => ({
          image: input.imageUrl,
          prompt: motionPromptOf(input),
          resolution: '720p',
          duration: ltxDuration(input.duration),
          seed: -1,
        }),
      }

    case 'ltx_i2v_lora':
      return {
        backend,
        model: LTX_I2V_LORA,
        useMultiShotQueue: false,
        needsSourceVideo: false,
        needsEndImage: false,
        needsMotionPrompt: true,
        needsLora: true,
        buildPayload: input => {
          const body: Record<string, unknown> = {
            image: input.imageUrl,
            prompt: motionPromptOf(input),
            resolution: '720p',
            duration: ltxDuration(input.duration),
            seed: -1,
          }
          if (input.loraUrl) {
            body.loras = [{ path: input.loraUrl, scale: input.loraScale ?? 0.8 }]
          }
          return body
        },
      }

    default:
      return resolveVideoBackend('seedance_i2v', technique)
  }
}

/** Backends shown in the Copy-Paste UI (order). */
export const VIDEO_BACKEND_OPTIONS: VideoBackend[] = [
  'auto',
  'kling_mc',
  'seedance_i2v',
  'seedance_i2v_turbo',
  'ltx_i2v',
  'ltx_i2v_lora',
  'wan_i2v',
]
