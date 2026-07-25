-- 020 — Monitor pipeline: character binding + replication fields on discovery_items

ALTER TABLE tracked_profiles
  ADD COLUMN IF NOT EXISTS character_id uuid REFERENCES characters(id) ON DELETE SET NULL;

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS trigger_word text;

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS content_type text
    CHECK (content_type IS NULL OR content_type IN ('video_gen', 'image_gen', 'carousel', 'real_photo', 'other')),
  ADD COLUMN IF NOT EXISTS scene_prompt text,
  ADD COLUMN IF NOT EXISTS generated_image_url text,
  ADD COLUMN IF NOT EXISTS kling_video_url text,
  ADD COLUMN IF NOT EXISTS replicate_status text NOT NULL DEFAULT 'none'
    CHECK (replicate_status IN (
      'none', 'pending_classify', 'classified', 'analyzing',
      'image_generating', 'image_done', 'video_generating', 'done', 'failed', 'skipped'
    )),
  ADD COLUMN IF NOT EXISTS replicate_error text;

CREATE INDEX IF NOT EXISTS idx_discovery_replicate_status
  ON discovery_items(user_id, replicate_status)
  WHERE replicate_status NOT IN ('none', 'done', 'skipped', 'failed');

INSERT INTO schema_migrations (name) VALUES ('020_monitor_pipeline') ON CONFLICT DO NOTHING;
