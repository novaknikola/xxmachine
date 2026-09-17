-- 091 — Script-only recreate: generate a video from a typed/spoken scene
-- script with no source Instagram reel at all. See the plan doc for context.

ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS is_script_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS lead_character TEXT;

INSERT INTO schema_migrations (name) VALUES ('091_kling_script_only') ON CONFLICT DO NOTHING;
