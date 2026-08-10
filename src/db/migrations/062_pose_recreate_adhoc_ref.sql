-- 062 — pose-recreate bot switches from picking a saved character to an
-- ad-hoc reference photo upload, matching Copy-Paste v2's own pattern
-- (one reference photo per run, not tied to a characters record).
--
-- pose_library gets a content_format bucket (post/story/carousel/reel/
-- fanvue_sfw/fanvue_nsfw) so each format draws from its own pool, matching
-- the "separate library per content type" requirement.
ALTER TABLE pose_library
  ADD COLUMN IF NOT EXISTS content_format TEXT;

CREATE INDEX IF NOT EXISTS idx_pose_library_format
  ON pose_library (user_id, active, content_format, nsfw);

-- Tracks "user picked a format, now waiting for the reference photo" between
-- the callback button press and the next photo message — the bot has no
-- other state to correlate those two updates.
CREATE TABLE IF NOT EXISTS telegram_recreate_pending (
  chat_id     BIGINT PRIMARY KEY,
  format      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (name) VALUES ('062_pose_recreate_adhoc_ref') ON CONFLICT DO NOTHING;
