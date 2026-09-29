-- 104 — "Viral monitoring" Sheet → IG Replicator bridge (src/lib/monitor/viral-sheet.ts).
-- A row ticked in the Sheet becomes a copy_paste_wan_jobs row that starts
-- BEFORE its source is resolved, so the Sheet gets a status right away:
-- queued → acquiring → awaiting_confirm → (existing Wan lifecycle, see 102).
--
-- origin: 'telegram' for every existing row / Telegram batch, 'sheet' for the bridge.
-- error_code: machine-readable reason next to the free-text `error`.
-- started_at / completed_at: per-job timing for the Sheet and the logs.

ALTER TABLE copy_paste_wan_jobs DROP CONSTRAINT IF EXISTS copy_paste_wan_jobs_status_check;
ALTER TABLE copy_paste_wan_jobs ADD CONSTRAINT copy_paste_wan_jobs_status_check
  CHECK (status IN (
    'queued', 'acquiring',
    'awaiting_confirm', 'still_generating', 'awaiting_approval', 'approved',
    'generating', 'done', 'failed', 'cancelled'
  ));

ALTER TABLE copy_paste_wan_jobs
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'telegram',
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- The same reel for the same character can be live only once from the Sheet.
-- Telegram submissions stay unconstrained (097: every submission is its own row).
-- failed/cancelled rows drop out, so a retry or a fresh tick can start it again.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_copy_paste_wan_jobs_sheet_active
  ON copy_paste_wan_jobs (user_id, lower(content_id), character_id)
  WHERE origin = 'sheet' AND status NOT IN ('failed', 'cancelled');

INSERT INTO schema_migrations (name) VALUES ('104_viral_sheet_replicator') ON CONFLICT DO NOTHING;
