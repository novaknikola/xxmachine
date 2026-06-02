-- 003 — characters (Instagram profiles / personas)

CREATE TABLE IF NOT EXISTS characters (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  -- Instagram Graph API (legacy, unused if using private API)
  instagram_user_id           TEXT,
  instagram_username          TEXT,
  instagram_access_token      TEXT,
  instagram_token_expires_at  TIMESTAMPTZ,
  -- Instagram private API
  ig_username                 TEXT,
  ig_password                 TEXT,
  ig_totp_secret              TEXT,
  ig_oauth_state              TEXT,
  ig_session                  JSONB,
  -- Google Drive
  google_access_token         TEXT,
  google_refresh_token        TEXT,
  google_drive_folder_id      TEXT,
  -- Browser automation
  proxy_url                   TEXT,
  browser_fingerprint         JSONB,
  -- Meta
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_characters_name ON characters (lower(name));
CREATE INDEX IF NOT EXISTS idx_characters_ig_username ON characters (ig_username);

-- 004 — Instagram queue

CREATE TABLE IF NOT EXISTS instagram_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id        UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_instagram_queue_character_status
  ON instagram_queue(character_id, status, scheduled_at);
