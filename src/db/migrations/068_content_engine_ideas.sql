-- 068 — Content Engine: idea history, separate from content_engine_scripts.
--
-- Every batch returned by "Suggest ideas" is logged here (source='suggested'), and every
-- topic actually run through /api/content-engine/scripts gets used_at stamped (whether it
-- came from a suggestion or was typed by hand, source='manual'). This is a topic-only log so
-- past ideas can be browsed/reused repeatedly -- not the same as content_engine_scripts (full
-- generated dialogue) and not the app's general image-generation History page.

create table if not exists content_engine_ideas (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  topic         text not null,
  source        text not null default 'suggested' check (source in ('suggested', 'manual')),
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists content_engine_ideas_user_id_idx
  on content_engine_ideas (user_id, created_at desc);

-- Same RLS posture as content_engine_scripts (030_enable_rls_remaining.sql pattern): app
-- connects via DATABASE_URL (postgres role, bypasses RLS), no permissive policy so
-- PostgREST/anon can never read or write.
alter table content_engine_ideas enable row level security;

insert into schema_migrations (name) values ('068_content_engine_ideas') on conflict do nothing;
