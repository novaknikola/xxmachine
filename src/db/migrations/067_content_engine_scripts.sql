-- 067 — Content Engine: AI script generator (isolated feature, own table).
--
-- Fully additive: no existing table/constraint touched, no FK from any
-- existing table into this one. Stores AI-drafted (Grok) dialogue scripts for
-- the car-interview format so past ideas can be browsed/edited/reused ahead
-- of the full render pipeline (characters/scenes/jobs), which lands in a
-- later migration once video rendering is wired in-app.

create table if not exists content_engine_scripts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  topic         text not null,
  script        jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists content_engine_scripts_user_id_idx
  on content_engine_scripts (user_id, created_at desc);

-- App connects via DATABASE_URL (postgres role, bypasses RLS) — same posture
-- as every other table in this app (see 030_enable_rls_remaining.sql):
-- RLS on, no permissive policy, so PostgREST/anon can never read or write.
alter table content_engine_scripts enable row level security;

insert into schema_migrations (name) values ('067_content_engine_scripts') on conflict do nothing;
