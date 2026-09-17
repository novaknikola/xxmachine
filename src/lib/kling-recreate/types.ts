import type { SeedanceVariant } from './seedance-client'

export type { SeedanceVariant }

/**
 * 'analyze' (default, omit for old callers): scrape -> analyze -> still ->
 * stop for still approval. 'approve_still': derive the dialogue summary from
 * the approved still's analysis -> stop for dialogue-attribution approval.
 * 'regenerate_still': clear the still and redo just that step off the
 * existing analysis. 'approve_dialogue': dialogue confirmed as-is -> build
 * the Seedance prompt -> stop for prompt approval. 'correct_dialogue': user
 * sent a free-text speaker correction -> re-derive the summary with that
 * correction applied, still awaiting confirmation. 'approve_prompt': fire
 * the actual paid Seedance call. 'regenerate_prompt': redo the synthesis
 * (shots/master_prompt) off the already-extracted 1fps frame descriptions,
 * then redo the still for the new shots.
 */
export type KlingRecreateAction =
  | 'analyze'
  | 'approve_still'
  | 'regenerate_still'
  | 'approve_dialogue'
  | 'correct_dialogue'
  | 'approve_prompt'
  | 'regenerate_prompt'

export interface KlingRecreateQueueInput {
  recreateJobId: string
  chatId: number
  action?: KlingRecreateAction
  /** Only used with action: 'correct_dialogue' — the user's free-text
   * speaker-attribution correction. */
  correction?: string
}

export interface KlingShotBeat {
  t_start: number
  t_end: number
  prompt: string
}

export interface KlingVideoContext {
  setting: string
  /**
   * The single reason this clip works — the specific payoff/point of the
   * dialogue and action, stated as a concrete fact, not a mood word. Not sent
   * to Kling as its own field; folded into master_prompt/shots so the video
   * model is steered toward the actual point of the clip, not just a neutral
   * transcription of what technically happens.
   */
  hook: string
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
  | 'awaiting_still_approval'
  | 'awaiting_dialogue_approval'
  | 'awaiting_prompt_approval'
  | 'rendering'
  | 'done'
  | 'failed'

/**
 * Chosen up front, before analysis even runs (see the shot-mode question in
 * the Telegram batch flow) — changes how the still-generation step behaves:
 * 'one_shot' always builds a single character still + single prompt, ignoring
 * how many camera/action beats Grok's analysis finds. 'multi_shot' builds one
 * character still PER shot (each anchored to that shot's own source frame),
 * only when the analysis actually finds 2-6 distinct beats — falls back to
 * one_shot behaviour otherwise, same as the old automatic choosePromptMode.
 */
export type KlingShotMode = 'one_shot' | 'multi_shot'

/** One character still generated for one multi-shot beat. */
export interface KlingShotStill {
  t_start: number
  t_end: number
  image_url: string
}

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
  /** Column name kept as-is (kling_*) to avoid a needless rename migration —
   * holds the Seedance render result now, not Kling. */
  kling_video_url: string | null
  kling_variant: string | null
  /** Holds the built Seedance payload (buildSeedanceI2VPayload output) once
   * the prompt gate is approved — same role kling_request had for Kling. */
  kling_request: Record<string, unknown> | null
  /** Kept as loose JSON — Kling-only settings (variant/cfg/sound/shot_type/
   * negative_prompt/element_list) are no longer read or written; the column
   * itself is left in place rather than dropped (see plan doc). */
  settings: Record<string, unknown>
  status: KlingRecreateStatus
  error: string | null
  parent_job_id?: string | null
  variation_note?: string | null
  shot_mode?: KlingShotMode | null
  custom_prompt?: string | null
  shot_stills?: KlingShotStill[] | null
  /** The Seedance prompt text once built (before payload assembly) — stored
   * so the dialogue gate's re-derivation and the prompt-approval message can
   * both read it back without re-calling Grok. */
  seedance_prompt?: string | null
  /** Free-text speaker-attribution correction from the dialogue gate, if the
   * user sent one — folded into buildSeedancePrompt with top priority. */
  confirmed_dialogue?: string | null
}

export const MAX_RECREATE_URLS = 30
export const MAX_FPS_FRAMES = 60
