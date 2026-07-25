-- 010 — Discovery layer: profiles, discovery feed, trending audios, pipeline jobs

set search_path = public;

create table if not exists tracked_profiles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  platform            text not null check (platform in ('Instagram', 'TikTok')),
  username            text not null,
  min_score           numeric not null default 10,
  max_age_days        integer not null default 14,
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED')),
  autopilot           boolean not null default false,
  autopilot_min_score numeric not null default 25,
  content_dna         text,
  last_scanned_at     timestamptz,
  reels_found         integer not null default 0,
  total_approved      integer not null default 0,
  created_at          timestamptz not null default now()
);

create unique index if not exists uidx_tracked_profiles_user_platform_username
  on tracked_profiles(user_id, platform, username);
create index if not exists idx_tracked_profiles_user on tracked_profiles(user_id);

create table if not exists discovery_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  platform        text not null,
  profile         text not null,
  content_url     text not null,
  content_id      text not null,
  views           bigint not null default 0,
  likes           bigint not null default 0,
  comments        bigint not null default 0,
  followers       bigint not null default 0,
  score           numeric not null default 0,
  velocity        numeric not null default 0,
  hook            text,
  audio_name      text,
  audio_id        text,
  category        text,
  posted_at       timestamptz,
  discovered_at   timestamptz not null default now(),
  admin_status    text not null default 'PENDING'
    check (admin_status in ('PENDING', 'APPROVED', 'REJECTED')),
  notes           text,
  pipeline_job_id uuid
);

create unique index if not exists uidx_discovery_user_content
  on discovery_items(user_id, content_id);
create index if not exists idx_discovery_user_status
  on discovery_items(user_id, admin_status);
create index if not exists idx_discovery_score on discovery_items(score desc);

create table if not exists trending_audios (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  audio_id      text not null,
  audio_name    text,
  platform      text,
  count_48h     integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  status        text not null default 'RISING'
    check (status in ('RISING', 'TRENDING', 'FADING'))
);

create unique index if not exists uidx_trending_audios_user_audio
  on trending_audios(user_id, audio_id);
create index if not exists idx_trending_audios_user on trending_audios(user_id);

create table if not exists pipeline_jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  discovery_item_id uuid references discovery_items(id),
  source_url        text not null,
  motion_notes      text,
  status            text not null default 'PENDING',
  video_drive_url   text,
  frame_drive_url   text,
  prompt            text,
  wavespeed_img_url text,
  wan_job_id        text,
  output_url        text,
  error             text,
  created_at        timestamptz not null default now(),
  done_at           timestamptz
);

create index if not exists idx_pipeline_jobs_user_status
  on pipeline_jobs(user_id, status);
create index if not exists idx_pipeline_jobs_wan_job
  on pipeline_jobs(wan_job_id) where wan_job_id is not null;
