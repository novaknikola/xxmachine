-- 099 — Per-job end-frame mode chosen in the Telegram still-approval gate:
--   'scene' (default, today's behaviour: end frame continues the scene),
--   'none'  (no last_image sent to Seedance),
--   'face'  (end frame is a close-up of the lead character's face, reached in
--            the last ~0.5s). Additive; every existing job stays 'scene'.

ALTER TABLE kling_recreate_jobs ADD COLUMN IF NOT EXISTS end_frame_mode TEXT NOT NULL DEFAULT 'scene';
ALTER TABLE kling_recreate_jobs DROP CONSTRAINT IF EXISTS kling_recreate_jobs_end_frame_mode_check;
ALTER TABLE kling_recreate_jobs ADD CONSTRAINT kling_recreate_jobs_end_frame_mode_check
  CHECK (end_frame_mode IN ('scene', 'none', 'face'));

INSERT INTO schema_migrations (name) VALUES ('099_kling_end_frame_mode') ON CONFLICT DO NOTHING;
