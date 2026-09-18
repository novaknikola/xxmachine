-- 093 — Ambiance/scene reference photo (separate from character identity
-- photos), plus a temporary holding column while a just-sent photo waits
-- for its explicit role answer ("which character, or ambiance?"). See the
-- plan doc for context — every uploaded photo now goes through an explicit
-- role question, no more caption shortcut or fast path.

ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS ambiance_photo_url TEXT;
ALTER TABLE telegram_recreate_pending ADD COLUMN IF NOT EXISTS ambiance_photo_url TEXT;
ALTER TABLE telegram_recreate_pending ADD COLUMN IF NOT EXISTS pending_photo_url TEXT;

INSERT INTO schema_migrations (name) VALUES ('093_kling_ambiance_photo') ON CONFLICT DO NOTHING;
