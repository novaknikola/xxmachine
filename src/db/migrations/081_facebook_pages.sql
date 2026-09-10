-- 081 — Facebook Pages scheduling (Reels via the Video Reels API).
--
-- Mirrors instagram_accounts/instagram_queue, minus every IG-private-API
-- field (ig_session, browser_fingerprint, proxy_url) that doesn't apply here:
-- Facebook publishing only ever goes through the official Graph API with a
-- long-lived (here: never-expiring, confirmed via /debug_token) Page Access
-- Token, no browser session needed.

create table if not exists facebook_pages (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  page_id                text not null unique,
  access_token           text not null,
  google_drive_folder_id text,
  created_at             timestamptz not null default now()
);

create table if not exists facebook_queue (
  id                 uuid primary key default gen_random_uuid(),
  page_id            uuid not null references facebook_pages(id) on delete cascade,
  drive_file_id      text,
  filename           text not null,
  status             text not null default 'pending',
  caption            text default '',
  scheduled_at       timestamptz,
  published_at       timestamptz,
  facebook_video_id  text,
  error_message      text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_facebook_queue_page_status
  on facebook_queue (page_id, status, scheduled_at);

create table if not exists facebook_auto_schedule_runs (
  run_date       date primary key,
  items_created  int not null default 0,
  created_at     timestamptz not null default now()
);

insert into schema_migrations (name) values ('081_facebook_pages') on conflict do nothing;
