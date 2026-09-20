-- 098 — Add copy_paste_wan to generation_queue's job_type allowlist. Missed
-- in 097, confirmed live 2026-09-20: every /bulk "Confirm Replicate" tap
-- failed with "violates check constraint generation_queue_job_type_check"
-- since the CHECK constraint (last widened in 086) never knew about it.

ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'image_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_paste_finish', 'copy_paste_wan', 'copy_prompts_generate',
    'seedance_i2v', 'infinite_talk', 'nsfw_carousel_generate',
    'kling_recreate_v1'
  ));

INSERT INTO schema_migrations (name) VALUES ('098_copy_paste_wan_job_type') ON CONFLICT DO NOTHING;
