-- User-level Google Drive auto-archive (separate from character/IG Drive tokens).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_access_token  TEXT,
  ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS google_token_expiry  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_root_folder_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_auto_archive   BOOLEAN NOT NULL DEFAULT false;

-- Cached folder ids: user × character × kind × model
CREATE TABLE IF NOT EXISTS drive_folders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_key  TEXT NOT NULL DEFAULT '_none',
  kind           TEXT NOT NULL,
  model_key      TEXT NOT NULL DEFAULT '_default',
  folder_id      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, character_key, kind, model_key)
);

CREATE INDEX IF NOT EXISTS idx_drive_folders_user ON drive_folders (user_id);

CREATE TABLE IF NOT EXISTS drive_exports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  character_key   TEXT NOT NULL DEFAULT '_none',
  kind            TEXT NOT NULL,
  model_key       TEXT NOT NULL DEFAULT '_default',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'uploading', 'done', 'failed', 'skipped')),
  drive_file_id   TEXT,
  drive_link      TEXT,
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  UNIQUE (user_id, source_type, source_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_drive_exports_pending
  ON drive_exports (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_drive_exports_user
  ON drive_exports (user_id, created_at DESC);

INSERT INTO schema_migrations (name)
VALUES ('028_drive_archive')
ON CONFLICT DO NOTHING;
