export type ContentType = 'video_gen' | 'image_gen' | 'carousel' | 'real_photo' | 'other'

export type ReplicateStatus =
  | 'none'
  | 'pending_classify'
  | 'classified'
  | 'analyzing'
  | 'video_generating'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'needs_review'

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
  /** User-uploaded identity photo for this batch — becomes Seedance's `image`. */
  reference_image_url: string | null
  /** The full CopyPasteSpec JSON produced by analysis. */
  copy_paste_spec: Record<string, unknown> | null
  /** Flattened prose sent to Seedance as `prompt` — user-editable before Replicate. */
  rendered_prompt: string | null
  source_aspect_ratio: '9:16' | '16:9' | '1:1' | 'other' | null
  source_width: number | null
  source_height: number | null
  source_duration: number | null
  source_cut_count: number | null
  kling_video_url: string | null
  video_model: string | null
  replicate_status: ReplicateStatus
  replicate_error: string | null
  posted_at: string | null
  discovered_at: string
}
