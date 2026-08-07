-- 052 — Characters (and their LoRAs) are private per user, not global.
-- Pre-existing characters were created before multi-user existed, so they
-- back-fill to the original admin who owns them.

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE characters
  SET user_id = 'f469a1b8-67fc-4103-8c6c-89e2873a1c7a'
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters (user_id);

INSERT INTO schema_migrations (name) VALUES ('052_characters_user_scope') ON CONFLICT DO NOTHING;
