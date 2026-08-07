-- 053 — Custom text a Telegram batch appends to every rendered prompt.
--
-- Set with /prompt <text> on an open batch, cleared with /prompt on its own.
-- Applied once per item at replicate time (appended to renderCopyPastePrompt's
-- output), not baked into the batch's stored urls/reference, so it never
-- retroactively changes a batch already submitted.

alter table telegram_batches
  add column if not exists custom_prompt text;

insert into schema_migrations (name) values ('053_telegram_batch_custom_prompt')
  on conflict do nothing;
