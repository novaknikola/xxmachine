-- 066 — /replicate <IG url> command: pending row carries the scraped image
-- URLs directly (no pose_library involvement) between the command and the
-- next photo upload.
ALTER TABLE telegram_recreate_pending
  ADD COLUMN IF NOT EXISTS ig_pose_urls TEXT[];

INSERT INTO schema_migrations (name) VALUES ('066_replicate_ig_pending') ON CONFLICT DO NOTHING;
