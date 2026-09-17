-- 092 — Multiple real reference photos per job (one per named character),
-- alongside the existing single-photo columns which stay untouched. See the
-- plan doc for context.

ALTER TABLE telegram_recreate_pending ADD COLUMN IF NOT EXISTS reference_photos JSONB NOT NULL DEFAULT '{}';
ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS reference_photos JSONB;

INSERT INTO schema_migrations (name) VALUES ('092_kling_multi_reference') ON CONFLICT DO NOTHING;
