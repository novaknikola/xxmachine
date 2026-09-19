-- 095 — SFW/NSFW still model choice (Nano Banana Pro Edit vs Seedream v5 Pro
-- Edit + Z-Image Turbo skin-enhance, the same NSFW workflow xxmachine's main
-- bulk-generation flow already uses). Default keeps today's behaviour
-- (nano_banana) unchanged for every existing job. See the plan doc.

ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS still_model TEXT NOT NULL DEFAULT 'nano_banana';
ALTER TABLE kling_recreate_jobs DROP CONSTRAINT IF EXISTS kling_recreate_jobs_still_model_check;
ALTER TABLE kling_recreate_jobs ADD CONSTRAINT kling_recreate_jobs_still_model_check
  CHECK (still_model IN ('nano_banana', 'seedream_nsfw'));

ALTER TABLE telegram_recreate_pending ADD COLUMN IF NOT EXISTS still_model TEXT;

INSERT INTO schema_migrations (name) VALUES ('095_kling_still_model') ON CONFLICT DO NOTHING;
