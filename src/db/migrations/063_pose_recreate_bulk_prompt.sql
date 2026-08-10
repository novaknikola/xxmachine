-- 063 — bulk count + "add prompt" step for the pose-recreate bot, mirroring
-- IGreplicator's (Copy-Paste v2) own bulk-count and add-prompt UX.
ALTER TABLE telegram_recreate_pending
  ADD COLUMN IF NOT EXISTS photo_url TEXT,
  ADD COLUMN IF NOT EXISTS count INT,
  ADD COLUMN IF NOT EXISTS awaiting_prompt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extra_prompt TEXT;

INSERT INTO schema_migrations (name) VALUES ('063_pose_recreate_bulk_prompt') ON CONFLICT DO NOTHING;
