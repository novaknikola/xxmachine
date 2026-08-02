-- 040 — Copy-Paste v2 keyframe step: Seedream v5 Pro Edit composites the
-- reference photo onto the source reel's first-second frame before Seedance.
-- `generated_image_url` (Seedream output) and `video_model` already exist
-- from the SceneSpec era (039 left them in place) — reused as-is. The
-- replicate_status CHECK constraint (022_video_technique.sql) already allows
-- 'image_generating'/'image_done', so no constraint change is needed here.

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS source_first_frame_url text;
