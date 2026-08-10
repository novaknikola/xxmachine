-- 061 — separate chat_id link for the pose-recreate bot (@contentreplicatorbot).
-- Same physical Telegram account gets a DIFFERENT chat_id per bot, so this
-- can't share users.telegram_chat_id (that column belongs to the existing
-- Copy-Paste bot and stays untouched).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS telegram_recreate_chat_id BIGINT;

INSERT INTO schema_migrations (name) VALUES ('061_recreate_bot_chat_id') ON CONFLICT DO NOTHING;
