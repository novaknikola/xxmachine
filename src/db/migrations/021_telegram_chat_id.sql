-- 021 — Telegram chat ID for monitor notifications

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS telegram_chat_id bigint;

INSERT INTO schema_migrations (name) VALUES ('021_telegram_chat_id') ON CONFLICT DO NOTHING;
