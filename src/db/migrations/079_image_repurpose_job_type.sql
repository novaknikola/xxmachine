-- 079 — image_repurpose was never added to the job_type allowlist, so every
-- Queue-mode image repurpose submission has failed a CHECK constraint at
-- INSERT time since the constraint was last redefined in 047_infinite_talk.

alter table generation_queue drop constraint if exists generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in (
    'bulk_image', 'video_repurpose', 'image_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_prompts_generate',
    'seedance_i2v', 'infinite_talk'
  ));

insert into schema_migrations (name) values ('079_image_repurpose_job_type') on conflict do nothing;
