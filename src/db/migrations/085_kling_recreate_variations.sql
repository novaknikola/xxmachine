-- 085 — Post-video Kling recreate variations.
-- Child jobs reuse the parent's still + analysis; variation_note is the
-- user's change text. telegram_recreate_pending.awaiting already holds
-- 'variation:<jobId>' so no pending-schema change.

ALTER TABLE kling_recreate_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES kling_recreate_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variation_note TEXT;

CREATE INDEX IF NOT EXISTS idx_kling_recreate_jobs_parent
  ON kling_recreate_jobs (parent_job_id);

INSERT INTO schema_migrations (name) VALUES ('085_kling_recreate_variations') ON CONFLICT DO NOTHING;
