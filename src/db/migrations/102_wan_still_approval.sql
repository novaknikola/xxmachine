-- 102 — The Seedream scene still is approved in Telegram before the paid Wan 3.0 call.
-- awaiting_confirm → still_generating → awaiting_approval → approved → generating → done
-- (Regenerate returns to awaiting_confirm; Cancel ends in cancelled.)

ALTER TABLE copy_paste_wan_jobs DROP CONSTRAINT IF EXISTS copy_paste_wan_jobs_status_check;
ALTER TABLE copy_paste_wan_jobs ADD CONSTRAINT copy_paste_wan_jobs_status_check
  CHECK (status IN (
    'awaiting_confirm', 'still_generating', 'awaiting_approval', 'approved',
    'generating', 'done', 'failed', 'cancelled'
  ));

INSERT INTO schema_migrations (name) VALUES ('102_wan_still_approval') ON CONFLICT DO NOTHING;
