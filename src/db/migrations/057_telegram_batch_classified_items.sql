-- 057 — Items a batch classified, awaiting the "confirm replicate?" tap.
--
-- Queueing the actual copy_paste_v2 job used to happen inside the same
-- next/server after() continuation that runs classification, in the
-- Telegram request's background. That silently drops sometimes on this
-- self-hosted setup (see cron/tick.ts's "Orphaned analyses" comment) with
-- no error logged, leaving items classified but never queued and no
-- Telegram message either way. Queueing now happens synchronously when the
-- user taps Confirm, the same reliable path the dashboard's own Replicate
-- button already uses — this column is just the handoff between the two.

alter table telegram_batches
  add column if not exists classified_item_ids uuid[] not null default '{}';

insert into schema_migrations (name) values ('057_telegram_batch_classified_items')
  on conflict do nothing;
