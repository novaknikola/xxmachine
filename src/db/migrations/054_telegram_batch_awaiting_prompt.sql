-- 054 — Flag for "the next text message from this chat is the custom prompt,
-- not reel links", set by the batch keyboard's Add prompt button.

alter table telegram_batches
  add column if not exists awaiting_prompt boolean not null default false;

insert into schema_migrations (name) values ('054_telegram_batch_awaiting_prompt')
  on conflict do nothing;
