-- 080 — Browser extension: personal access tokens + a place for clipped images.
--
-- The extension can't rely on the dashboard's httpOnly session cookie (it's a
-- cross-site request from the extension's own origin), so it authenticates
-- with a long-lived bearer token instead. Only the hash is stored, same idea
-- as a GitHub PAT — the raw value is shown once, at generation time.
--
-- Clipped images are stored as pinterest_pins rows under one auto-created
-- "Browser Clips" board per user, so the whole existing Pinterest tab
-- (browse, search, select, Save to stories, Generate) works on them for free.

create table if not exists personal_access_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null,
  label         text not null default 'Browser extension',
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists idx_personal_access_tokens_hash
  on personal_access_tokens (token_hash);

create index if not exists idx_personal_access_tokens_user
  on personal_access_tokens (user_id);

insert into schema_migrations (name) values ('080_extension_clips') on conflict do nothing;
