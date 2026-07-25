-- 013 — Allow video_transcribe job_type in generation_queue (bulk transcribe-to-CSV)

set search_path = public;

alter table generation_queue drop constraint generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in ('bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe'));
