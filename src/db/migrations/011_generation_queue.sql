-- 011 — Generation queue for background processing (bulk_image, video_repurpose)

set search_path = public;

create table if not exists generation_queue (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  job_type     text not null check (job_type in ('bulk_image', 'video_repurpose')),
  status       text not null default 'pending'
                 check (status in ('pending', 'processing', 'done', 'failed', 'cancelled')),
  input        jsonb not null default '{}',
  output       jsonb,
  attempts     integer not null default 0,
  max_attempts integer not null default 3,
  progress     integer not null default 0,
  total_items  integer not null default 0,
  done_items   integer not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create index if not exists idx_generation_queue_status_created
  on generation_queue(status, created_at);
create index if not exists idx_generation_queue_user_created
  on generation_queue(user_id, created_at desc);
