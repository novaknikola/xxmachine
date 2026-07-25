ALTER TABLE characters
ADD COLUMN IF NOT EXISTS telegram_channel_id TEXT;

INSERT INTO schema_migrations (name)
VALUES ('011_character_telegram_channel')
ON CONFLICT DO NOTHING;