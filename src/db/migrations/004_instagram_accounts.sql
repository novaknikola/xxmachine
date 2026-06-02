-- 004 — instagram_accounts (dedicated table, separate from LoRA characters)

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  ig_username         TEXT,
  ig_password         TEXT,
  ig_totp_secret      TEXT,
  ig_session          JSONB,
  proxy_url           TEXT,
  browser_fingerprint JSONB,
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_drive_folder_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ig_accounts_username ON instagram_accounts (ig_username);

-- Recreate instagram_queue to reference instagram_accounts
DROP TABLE IF EXISTS instagram_queue;

CREATE TABLE IF NOT EXISTS instagram_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  drive_file_id       TEXT,
  filename            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  caption             TEXT DEFAULT '',
  scheduled_at        TIMESTAMPTZ,
  published_at        TIMESTAMPTZ,
  instagram_media_id  TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_queue_account_status
  ON instagram_queue(account_id, status, scheduled_at);
