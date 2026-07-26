export type ContentType = 'video_gen' | 'image_gen' | 'carousel' | 'real_photo' | 'other'

/**
 * What the source shot *requires*, not which product made it — a generated clip
 * carries no reliable fingerprint of its origin model, but the motion structure
 * of the shot is measurable and is what decides our own model choice.
 */
export type VideoTechnique =
  | 'motion_transfer'   // body/camera motion copied 1:1 from the source clip
  | 'image_to_video'    // one still + prompted motion, single continuous shot
  | 'first_last_frame'  // clear A -> B state change, interpolated between keyframes
  | 'multi_shot'        // several cuts, each segment generated then stitched
  | 'extend'            // continuous shot longer than a single generation allows
  | 'unknown'

export type ReplicateStatus =
  | 'none'
  | 'pending_classify'
  | 'classified'
  | 'analyzing'
  | 'image_generating'
  | 'image_done'
  | 'video_generating'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'needs_review'

/** Keyframe generator for Copy-Paste / monitor replicate. */
export type ImageModel = 'z_image' | 'seedream_edit'

export interface TrackedProfileRow {
  id: string
  user_id: string
  platform: string
  username: string
  min_score: number
  max_age_days: number
  status: string
  autopilot: boolean
  autopilot_min_score: number
  character_id: string | null
  last_scanned_at: string | null
}

export interface DiscoveryItemRow {
  id: string
  user_id: string
  platform: string
  profile: string
  content_url: string
  content_id: string
  views: number
  likes: number
  comments: number
  followers: number
  score: number
  admin_status: string
  thumbnail_url: string | null
  video_url: string | null
  content_type: ContentType | null
  video_technique: VideoTechnique | null
  technique_confidence: number | null
  technique_reasoning: string | null
  scene_prompt: string | null
  /** Structured body/wardrobe/pose/hook/speech capture used to build scene_prompt. */
  scene_spec: Record<string, unknown> | null
  end_scene_prompt: string | null
  motion_prompt: string | null
  generated_image_url: string | null
  generated_end_image_url: string | null
  kling_video_url: string | null
  video_model: string | null
  /** z_image | seedream_edit — last/selected keyframe backend. */
  image_model: ImageModel | string | null
  source_duration: number | null
  source_cut_count: number | null
  replicate_status: ReplicateStatus
  replicate_error: string | null
  posted_at: string | null
  discovered_at: string
}

export interface CharacterLora {
  id: string
  name: string
  lora_url: string | null
  lora_scale: number
  trigger_word: string | null
  base_prompt_style: string | null
}
