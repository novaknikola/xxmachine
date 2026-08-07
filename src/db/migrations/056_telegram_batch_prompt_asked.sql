-- 056 — Tracks whether a batch has already been offered the "add anything
-- to the prompt?" choice, so it is asked once (when photo+links first come
-- together) rather than every time more links are added afterward.

alter table telegram_batches
  add column if not exists prompt_asked boolean not null default false;

insert into schema_migrations (name) values ('056_telegram_batch_prompt_asked')
  on conflict do nothing;
