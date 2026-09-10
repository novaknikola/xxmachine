-- 081 — Instagram OAuth hardening
-- Tenant column + UNIQUE (user_id, ig_user_id), token metadata, single-use OAuth state.
-- Secret ciphertext itself is written by the Node encrypt helpers (see
-- scripts/encrypt-instagram-secrets.mjs) — SQL cannot AES-GCM the existing rows.

ALTER TABLE instagram_accounts
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS ig_token_app_id TEXT,
  ADD COLUMN IF NOT EXISTS ig_token_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS ig_token_status_reason TEXT,
  ADD COLUMN IF NOT EXISTS ig_publish_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ig_token_refresh_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ig_token_last_refresh_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ig_token_next_refresh_at TIMESTAMPTZ;

-- Pre-tenant rows belong to the earliest active admin (same idea as 052, without a hardcoded UUID).
UPDATE instagram_accounts ia
   SET user_id = u.id
  FROM (
    SELECT id
      FROM users
     WHERE active = true
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at
     LIMIT 1
  ) u
 WHERE ia.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_instagram_accounts_user
  ON instagram_accounts (user_id);

CREATE INDEX IF NOT EXISTS idx_instagram_accounts_token_refresh
  ON instagram_accounts (ig_token_next_refresh_at)
  WHERE ig_access_token IS NOT NULL;

-- If the overwrite bug already produced two rows with the same IG user on one tenant,
-- keep the freshest token and force the rest to reconnect so the unique index can apply.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, ig_user_id
           ORDER BY ig_token_expires_at DESC NULLS LAST, created_at DESC
         ) AS rn
    FROM instagram_accounts
   WHERE user_id IS NOT NULL
     AND ig_user_id IS NOT NULL
)
UPDATE instagram_accounts a
   SET ig_user_id = NULL,
       ig_access_token = NULL,
       ig_token_status = 'reconnect_required',
       ig_token_status_reason = 'Duplicate Instagram user id on this tenant — reconnect the correct profile',
       ig_publish_paused = TRUE
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

-- Partial unique index: unconnected rows (NULL ig_user_id) may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS instagram_accounts_user_ig_user_uidx
  ON instagram_accounts (user_id, ig_user_id)
  WHERE user_id IS NOT NULL AND ig_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  nonce       TEXT PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_oauth_states_expires
  ON instagram_oauth_states (expires_at)
  WHERE consumed_at IS NULL;
