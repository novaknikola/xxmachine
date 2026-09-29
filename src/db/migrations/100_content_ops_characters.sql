-- 100 — Replicator output filed under the chosen character, not the source
-- reel's IG handle; each character carries its own reference photo.

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS reference_image_url TEXT;

ALTER TABLE telegram_batches
  ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES characters(id) ON DELETE SET NULL;

ALTER TABLE copy_paste_wan_jobs
  ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES characters(id) ON DELETE SET NULL;

INSERT INTO schema_migrations (name) VALUES ('100_content_ops_characters') ON CONFLICT DO NOTHING;
