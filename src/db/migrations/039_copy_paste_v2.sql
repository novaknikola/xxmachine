-- 039 — Copy-Paste v2: reference-photo + Seedance 2.0 single-path pipeline,
-- replacing the SceneSpec + multi-backend/technique routing. Old SceneSpec-era
-- columns (scene_spec, scene_prompt, motion_prompt, end_scene_prompt,
-- generated_image_url, generated_end_image_url, video_technique,
-- technique_confidence, technique_reasoning, image_model) are left in place,
-- unused — a follow-up cleanup migration can drop them once verified live.

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS reference_image_url text,
  ADD COLUMN IF NOT EXISTS copy_paste_spec jsonb,
  ADD COLUMN IF NOT EXISTS rendered_prompt text,
  ADD COLUMN IF NOT EXISTS source_aspect_ratio text
    CHECK (source_aspect_ratio IS NULL OR source_aspect_ratio IN ('9:16', '16:9', '1:1', 'other')),
  ADD COLUMN IF NOT EXISTS source_width integer,
  ADD COLUMN IF NOT EXISTS source_height integer;

-- Bulk Copy-Paste replication becomes a server-side queue job, mirroring
-- bulk_carousel, instead of the client-side sequential loop.
ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2'
  ));
