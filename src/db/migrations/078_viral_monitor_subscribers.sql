-- 078 — Self-service subscribers for the isolated @igreplicatorbot viral
-- report. Anyone who /start's the bot is added here; /stop or a blocked-bot
-- delivery failure removes them. Fully separate from users/telegram_chat_id
-- and every other bot's state.

CREATE TABLE IF NOT EXISTS viral_monitor_subscribers (
  chat_id        BIGINT PRIMARY KEY,
  subscribed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (name) VALUES ('078_viral_monitor_subscribers') ON CONFLICT DO NOTHING;
