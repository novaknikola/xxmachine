import type { KlingVariant, KlingShotType } from './kling-client'

export type { KlingVariant, KlingShotType }

export interface KlingUserSettings {
  variant: KlingVariant
  duration_mode: 'auto' | 'fixed'
  duration_sec: number | null
  sound: boolean
  cfg_scale: number
  shot_type: KlingShotType
  negative_prompt: string | null
  element_list: string[]
}

export const DEFAULT_KLING_SETTINGS: KlingUserSettings = {
  variant: 'pro',
  duration_mode: 'auto',
  duration_sec: null,
  sound: true,
  cfg_scale: 0.5,
  shot_type: 'customize',
  negative_prompt: null,
  element_list: [],
}

export interface KlingRecreateQueueInput {
  recreateJobId: string
  chatId: number
}

export interface KlingShotBeat {
  t_start: number
  t_end: number
  prompt: string
}

export interface KlingVideoContext {
  setting: string
  character_action: string
  camera: string
  speech: string | null
  duration_sec: number | null
  aspect_ratio: string
  shots: KlingShotBeat[]
  /**
   * How the Kling payload was filled:
   * - `multi_prompt` when analysis produced 2–6 shot beats (max 6).
   * - `prompt` otherwise (single master textual prompt).
   * Never both — WaveSpeed rejects prompt + multi_prompt together.
   * `end_image` is not used when `multi_prompt` is chosen (incompatible).
   */
  prompt_mode: 'prompt' | 'multi_prompt'
}

export interface KlingFrameRow {
  t_sec: number
  image_url: string
  description: string | null
  base64?: string
}

export type KlingRecreateStatus =
  | 'pending'
  | 'scraping'
  | 'analyzing'
  | 'still'
  | 'rendering'
  | 'done'
  | 'failed'

export interface KlingRecreateJobRow {
  id: string
  user_id: string
  queue_job_id: string | null
  chat_id: number | string | null
  source_url: string
  video_url: string | null
  duration_sec: number | string | null
  reference_image_url: string | null
  context: KlingVideoContext | Record<string, unknown> | null
  master_prompt: string | null
  character_image_url: string | null
  kling_video_url: string | null
  kling_variant: string | null
  kling_request: Record<string, unknown> | null
  settings: KlingUserSettings | Record<string, unknown>
  status: KlingRecreateStatus
  error: string | null
  parent_job_id?: string | null
  variation_note?: string | null
}

export const MAX_RECREATE_URLS = 30
export const MAX_FPS_FRAMES = 60
