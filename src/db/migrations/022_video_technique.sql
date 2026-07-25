-- Technique detection: which video generation approach a source reel actually requires.
-- The pipeline previously hardcoded Kling motion-control for every video_gen item.

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS video_technique text
    CHECK (video_technique IS NULL OR video_technique IN (
      'motion_transfer', 'image_to_video', 'first_last_frame',
      'multi_shot', 'extend', 'unknown'
    )),
  ADD COLUMN IF NOT EXISTS technique_confidence real,
  ADD COLUMN IF NOT EXISTS technique_reasoning text,
  -- Second image target for first_last_frame: describes the END state of the shot.
  ADD COLUMN IF NOT EXISTS end_scene_prompt text,
  -- Describes movement only, fed to image-to-video and keyframe models.
  ADD COLUMN IF NOT EXISTS motion_prompt text,
  ADD COLUMN IF NOT EXISTS generated_end_image_url text,
  -- Audit trail: the WaveSpeed endpoint that actually produced kling_video_url.
  ADD COLUMN IF NOT EXISTS video_model text,
  -- Hard signals measured from the source file, not inferred by the vision model.
  ADD COLUMN IF NOT EXISTS source_duration real,
  ADD COLUMN IF NOT EXISTS source_cut_count integer;

-- 'needs_review' parks items whose technique we can detect but not yet execute
-- (multi-cut sequences, clips longer than one generation) instead of burning
-- credits on a call that cannot reproduce them.
ALTER TABLE discovery_items DROP CONSTRAINT IF EXISTS discovery_items_replicate_status_check;
ALTER TABLE discovery_items ADD CONSTRAINT discovery_items_replicate_status_check
  CHECK (replicate_status IN (
    'none', 'pending_classify', 'classified', 'analyzing',
    'image_generating', 'image_done', 'video_generating',
    'done', 'failed', 'skipped', 'needs_review'
  ));

CREATE INDEX IF NOT EXISTS idx_discovery_technique
  ON discovery_items(user_id, video_technique)
  WHERE video_technique IS NOT NULL;

INSERT INTO schema_migrations (name) VALUES ('022_video_technique') ON CONFLICT DO NOTHING;
