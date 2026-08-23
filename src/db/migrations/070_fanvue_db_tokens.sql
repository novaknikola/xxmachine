-- Persist the Fanvue agency OAuth connection server-side (singleton row) instead of only in
-- httpOnly browser cookies, so cron/worker contexts (no request, no cookies) can authenticate.
-- One agency token acts on behalf of every creator via /creators/{uuid}/... scoped paths —
-- there is one connection, not one per creator.
create table if not exists fanvue_connection (
  id integer primary key default 1 check (id = 1),
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  expires_at bigint not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cache of creators visible under the agency connection, refreshed on connect/sync.
-- Lets `characters` link to a Fanvue account without a live API call on every page load.
create table if not exists fanvue_creators (
  creator_uuid uuid primary key,
  handle text,
  display_name text,
  avatar_url text,
  synced_at timestamptz not null default now()
);

alter table characters
  add column if not exists fanvue_creator_uuid uuid references fanvue_creators(creator_uuid) on delete set null;
