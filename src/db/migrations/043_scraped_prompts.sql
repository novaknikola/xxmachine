-- 043 — Copy Prompts: scraped-prompt library (youmind import) + new queue job type.

create table if not exists scraped_prompts (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null default 'youmind',
  source_id          text not null,
  source_rank        integer not null,
  title              text,
  prompt             text not null,
  raw_prompt         text not null,
  has_template_args  boolean not null default false,
  author             text,
  source_url         text,
  source_link        text,
  preview_image_url  text,
  media_urls         text[] not null default '{}',
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  imported_at        timestamptz not null default now()
);

create unique index if not exists idx_scraped_prompts_source_sourceid
  on scraped_prompts (source, source_id);

create index if not exists idx_scraped_prompts_browse
  on scraped_prompts (is_active, source_rank);

create index if not exists idx_scraped_prompts_author
  on scraped_prompts (author) where is_active;

alter table generation_queue drop constraint if exists generation_queue_job_type_check;
alter table generation_queue add constraint generation_queue_job_type_check
  check (job_type in (
    'bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_prompts_generate'
  ));

insert into schema_migrations (name) values ('043_scraped_prompts') on conflict do nothing;
