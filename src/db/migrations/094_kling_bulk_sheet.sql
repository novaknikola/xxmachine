-- 094 — Bulk Google Sheets trigger: jobs created from a "Kling Bulk Queue"
-- sheet tab carry a human label (for Telegram notifications) and a pointer
-- back to their source row (for Sheet status write-back). Both null for
-- ordinary Telegram-created jobs. See the plan doc for context.

ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS source_label TEXT;
ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS sheet_row INT;

INSERT INTO schema_migrations (name) VALUES ('094_kling_bulk_sheet') ON CONFLICT DO NOTHING;
