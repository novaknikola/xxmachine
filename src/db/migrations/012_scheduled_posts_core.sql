CREATE TABLE IF NOT EXISTS scheduled_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  image_urls TEXT[],
  caption TEXT NOT NULL,
  platforms TEXT[] NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  telegram_message_id INTEGER,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  published_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
ON scheduled_posts(status, scheduled_at);

INSERT INTO schema_migrations (name)
VALUES ('012_scheduled_posts_core')
ON CONFLICT DO NOTHING;