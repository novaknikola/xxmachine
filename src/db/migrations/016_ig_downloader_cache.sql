-- 016 — IG Downloader cache: per-user scraped profile/reel history to avoid redundant Apify scans

set search_path = public;

create table if not exists ig_downloader_profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  username         text not null,
  last_scanned_at  timestamptz not null default now(),
  reels_found      integer not null default 0,
  created_at       timestamptz not null default now()
);

create unique index if not exists uidx_ig_downloader_profiles_user_username
  on ig_downloader_profiles(user_id, username);

create table if not exists ig_downloader_reels (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  username      text not null,
  shortcode     text not null,
  permalink     text not null,
  video_url     text not null,
  thumbnail_url text,
  views         bigint not null default 0,
  likes         bigint not null default 0,
  comments      bigint not null default 0,
  posted_at     timestamptz,
  source        text not null,
  scraped_at    timestamptz not null default now()
);

create unique index if not exists uidx_ig_downloader_reels_user_shortcode
  on ig_downloader_reels(user_id, shortcode);
create index if not exists idx_ig_downloader_reels_user_username
  on ig_downloader_reels(user_id, username);
