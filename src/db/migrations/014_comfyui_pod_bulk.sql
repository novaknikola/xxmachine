-- 014 — comfyui_pod_bulk job_type + saved ComfyUI workflow templates

set search_path = public;

alter table generation_queue drop constraint generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in ('bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe', 'comfyui_pod_bulk'));

create table if not exists comfyui_templates (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  workflow_json jsonb not null,
  prompt_node_id text not null,
  prompt_field  text not null default 'text',
  image_node_id text,
  image_field   text default 'image',
  created_at    timestamptz not null default now()
);

create index if not exists idx_comfyui_templates_user on comfyui_templates(user_id, created_at desc);
