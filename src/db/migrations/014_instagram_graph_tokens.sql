ALTER TABLE instagram_accounts
ADD COLUMN IF NOT EXISTS ig_user_id TEXT,
ADD COLUMN IF NOT EXISTS ig_access_token TEXT,
ADD COLUMN IF NOT EXISTS ig_token_expires_at TIMESTAMPTZ;

INSERT INTO schema_migrations (name)
VALUES ('014_instagram_graph_tokens')
ON CONFLICT DO NOTHING;