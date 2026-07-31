-- 037 — Allow paused status for generation_queue (My Pod pause/resume)
ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_status_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_status_check
  CHECK (status IN ('pending', 'processing', 'paused', 'done', 'failed', 'cancelled'));
