-- 051 — Repurpose options the Telegram bot remembers per user.
--
-- The bot is used one-handed on a phone: asking for variant count, effects and
-- destination on every run would be more taps than the job is worth. These are
-- set once with /settings and reused, and are deliberately separate from the web
-- Studio settings — the same person wants different defaults in the two places
-- (a quick phone run is not a considered desktop batch).

create table if not exists telegram_repurpose_settings (
  user_id                uuid primary key references users(id) on delete cascade,
  -- Matches the Copy-Paste studio default; 1-100 is enforced by the queue.
  variant_count          int  not null default 5,
  -- VideoEffectOpts. Stored whole so adding an effect needs no migration.
  effects                jsonb not null default
    '{"brightness":true,"contrast":true,"saturation":true,"hue":true,"speed":true,"flipH":true,"crop":true,"fade":false}'::jsonb,
  -- Empty means the computed {character}/{kind}/{stage}/{date} archive tree.
  output_drive_folder_id text,
  updated_at             timestamptz not null default now()
);

insert into schema_migrations (name) values ('051_telegram_repurpose_settings')
  on conflict do nothing;
