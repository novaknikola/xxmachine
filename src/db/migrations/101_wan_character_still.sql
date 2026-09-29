-- 101 — Per-character prompt for the Replicator: reference photo + prompt go
-- through Seedream v5 Edit + Z-Image Turbo, and that still is sent to Wan 3.0
-- alongside the original reference photo.

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS wan_prompt TEXT;

ALTER TABLE copy_paste_wan_jobs
  ADD COLUMN IF NOT EXISTS still_prompt TEXT,
  ADD COLUMN IF NOT EXISTS still_image_url TEXT;

INSERT INTO schema_migrations (name) VALUES ('101_wan_character_still') ON CONFLICT DO NOTHING;
