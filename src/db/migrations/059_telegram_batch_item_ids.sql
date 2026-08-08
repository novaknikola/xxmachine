-- 059 — All discovery_items ever created for a batch, populated immediately
-- (synchronously, in the same request as the Replicate tap) rather than
-- after background classification finishes.
--
-- classified_item_ids only gets written by the classify continuation's own
-- completion signal, which has twice now silently failed to fire on real
-- batches even though every item finished classifying without error (see
-- cron/tick.ts's "Stalled batch confirmations" sweep, which needs item_ids
-- to know what to check regardless of whether that signal ever arrives).

alter table telegram_batches
  add column if not exists item_ids uuid[] not null default '{}';

insert into schema_migrations (name) values ('059_telegram_batch_item_ids')
  on conflict do nothing;
