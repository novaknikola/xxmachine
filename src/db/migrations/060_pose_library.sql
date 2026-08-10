-- 060 — pose_library: reusable pose/scene reference images for the "recreate"
-- pipeline (same pose/framing/environment, different identity via Seedream
-- Edit — same reference-lock mechanism Copy-Paste v2 already uses, just
-- sourced from a stored pool image instead of an analyzed reel frame).
--
-- Purely additive: new table only, no existing table/constraint touched.

CREATE TABLE IF NOT EXISTS pose_library (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  category      TEXT,
  nsfw          BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  used_count    INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pose_library_user_active
  ON pose_library (user_id, active, nsfw);

INSERT INTO schema_migrations (name) VALUES ('060_pose_library') ON CONFLICT DO NOTHING;
