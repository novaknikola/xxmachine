-- 044 — Pinterest: imported boards and their pins, browsed from Copy Prompts.
--
-- Pins are stored as URLs only. i.pinimg.com serves unsigned, non-expiring
-- images with no referer check, and Seedream fetches a reference URL itself, so
-- nothing is ever downloaded or re-hosted -- see src/lib/scene-refs.ts.

create table if not exists pinterest_boards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  -- "<owner>/<slug>" from the board URL; the natural key Pinterest gives us.
  board_key     text not null,
  owner         text not null,
  slug          text not null,
  title         text,
  board_url     text not null,
  pin_count     integer not null default 0,
  last_error    text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  synced_at     timestamptz
);

create unique index if not exists idx_pinterest_boards_user_key
  on pinterest_boards (user_id, board_key);

create table if not exists pinterest_pins (
  id            uuid primary key default gen_random_uuid(),
  board_id      uuid not null references pinterest_boards(id) on delete cascade,
  -- Pinterest's own pin id where the source exposes it; otherwise the image
  -- hash path, which is equally stable and keeps re-imports idempotent.
  pin_key       text not null,
  pin_url       text,
  title         text,
  -- Grid thumbnail, served straight to the browser.
  image_url     text not null,
  -- Same image with the size segment swapped to /originals/ — what gets handed
  -- to Seedream when the pin is picked as a scene reference.
  image_url_hd  text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create unique index if not exists idx_pinterest_pins_board_key
  on pinterest_pins (board_id, pin_key);

create index if not exists idx_pinterest_pins_browse
  on pinterest_pins (board_id, created_at desc) where is_active;

insert into schema_migrations (name) values ('044_pinterest_boards') on conflict do nothing;
