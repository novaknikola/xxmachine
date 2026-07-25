-- 015 — Allow video_ocr job_type in generation_queue (on-screen text extraction)

set search_path = public;

alter table generation_queue drop constraint generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in ('bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe', 'comfyui_pod_bulk', 'video_ocr'));
