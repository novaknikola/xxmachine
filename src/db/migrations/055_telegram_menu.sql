-- 055 — Support for the Telegram /menu: account-level "waiting for a text
-- reply" state (used by the API-key button, distinct from the batch-scoped
-- awaiting_prompt), and a per-user end-frame default the bot can toggle.

alter table users
  add column if not exists telegram_awaiting text;

alter table telegram_repurpose_settings
  add column if not exists end_frame_mode text not null default 'auto'
    check (end_frame_mode in ('auto', 'always', 'off'));

insert into schema_migrations (name) values ('055_telegram_menu')
  on conflict do nothing;
