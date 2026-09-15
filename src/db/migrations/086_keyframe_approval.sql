-- 086 — Keyframe approval gate for Copy-Paste v2.
--
-- The Seedream keyframe(s) used to flow straight into the paid, ~45min
-- Seedance video-edit call with no human check in between. New status
-- 'awaiting_keyframe_approval' parks an item there once its keyframe(s) are
-- generated; the Run tab and Telegram (kfok:/kfrg: callbacks) both offer
-- Approve/Regenerate from that state. copy_paste_finish is the job type the
-- Approve action enqueues to run the actual Seedance call afterward, mirroring
-- how copy_paste_v2 itself is enqueued to avoid nginx's 300s timeout.

ALTER TABLE discovery_items DROP CONSTRAINT IF EXISTS discovery_items_replicate_status_check;
ALTER TABLE discovery_items ADD CONSTRAINT discovery_items_replicate_status_check
  CHECK (replicate_status IN (
    'none', 'pending_classify', 'classified', 'analyzing',
    'image_generating', 'image_done', 'awaiting_keyframe_approval', 'video_generating',
    'done', 'failed', 'skipped', 'needs_review'
  ));

ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'image_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_paste_finish', 'copy_prompts_generate',
    'seedance_i2v', 'infinite_talk', 'nsfw_carousel_generate',
    'kling_recreate_v1'
  ));

INSERT INTO schema_migrations (name) VALUES ('086_keyframe_approval') ON CONFLICT DO NOTHING;
