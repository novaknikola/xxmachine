-- Multi-shot replication runs as a background queue job (per-segment generation + stitch).

ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot'
  ));

INSERT INTO schema_migrations (name) VALUES ('025_monitor_multi_shot') ON CONFLICT DO NOTHING;
