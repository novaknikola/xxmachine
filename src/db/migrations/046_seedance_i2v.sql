-- 046 — Image to Video: Seedance v1.5 Pro i2v batches on RunPod serverless.
--
-- Adds the job type only. The batch itself lives in generation_queue.input like
-- every other job, so nothing new is needed to store or resume it.

alter table generation_queue drop constraint if exists generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in (
    'bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_prompts_generate',
    'seedance_i2v'
  ));

insert into schema_migrations (name) values ('046_seedance_i2v') on conflict do nothing;
