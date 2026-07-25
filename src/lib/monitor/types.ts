export type ContentType = 'video_gen' | 'image_gen' | 'carousel' | 'real_photo' | 'other'

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
  scene_prompt: string | null
  generated_image_url: string | null
  kling_video_url: string | null
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
