-- Reverts 070's characters.fanvue_creator_uuid — Fanvue accounts are real, already-known
-- entities from the live agency API; routing them through a local "character" (a concept
-- built for IG personas with LoRA/prompt config) was unnecessary indirection.
alter table characters drop column if exists fanvue_creator_uuid;

-- Fanvue's own dedicated schedule queue — independent of `scheduled_posts`/`characters`,
-- which the shared (non-owner-gated) /schedule page also reads. Keyed directly on the
-- Fanvue creator_uuid from the live API, nothing local to keep in sync.
create table if not exists fanvue_scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  creator_uuid uuid not null,
  creator_display_name text,
  image_url text not null,
  caption text not null,
  scheduled_at timestamptz not null,
  status text not null default 'pending', -- pending | published | failed
  error text,
  published_at timestamptz,
  post_uuid text,
  created_at timestamptz not null default now()
);

create index if not exists fanvue_scheduled_posts_due_idx
  on fanvue_scheduled_posts (scheduled_at)
  where status = 'pending';
