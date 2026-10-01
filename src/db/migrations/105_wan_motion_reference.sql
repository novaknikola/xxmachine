-- 105 — Wan 3.0 no longer gets the raw source reel. It gets a copy with the
-- source person scrubbed to a grey blur (motion, camera, timing and sound kept;
-- tattoos, piercings, makeup, hair colour gone) — see wan-motion-reference.ts.
-- This is that copy, kept so every job shows exactly what Wan was sent.

ALTER TABLE copy_paste_wan_jobs
  ADD COLUMN IF NOT EXISTS motion_video_url TEXT;

INSERT INTO schema_migrations (name) VALUES ('105_wan_motion_reference') ON CONFLICT DO NOTHING;
