-- 106 — Photo Replicator phase 2 (src/lib/monitor/photo-jobs.ts).
-- A row ticked in the "Photo Replicator" tab becomes one photo_replicator_jobs
-- row — the source of truth; the Sheet only mirrors it (J–N).
--
-- queued → generating → awaiting_approval ─ Approve → approved → archiving → archived
--                ↑              │                      (Drive raw/ — what the farm reads)
--                └─ Regenerate ─┤ (at most 3 generations per job, then REGEN_LIMIT)
--                               └─ Reject → rejected
-- failed: error_code says why. A failed job that already has an approved result
-- (or an unapproved one) resumes from it — a paid generation is never repeated
-- for a Drive or Telegram problem.

CREATE TABLE IF NOT EXISTS photo_replicator_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id text,
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  -- The Phase 1 photo (our storage, column A) and its sha256 (the object name).
  source_url text NOT NULL,
  source_sha256 text NOT NULL,
  -- Column C: the Instagram post (?img_index=N kept).
  source_link text,
  -- Optional sharper copy of the same photo (phase 2D); NULL = the Phase 1 photo is used.
  resolved_source_url text,
  source_note text,
  format text NOT NULL CHECK (format IN ('post', 'story', 'carousel')),
  slides int NOT NULL DEFAULT 1 CHECK (slides BETWEEN 1 AND 3),
  prompt_addition text,
  -- What the base edit was actually sent (audit; set per generation).
  prompt text,
  sheet_row int,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'generating', 'awaiting_approval', 'approved', 'archiving', 'archived', 'failed', 'rejected'
  )),
  -- Generations started for this job (Regenerate included); capped at 3 in code.
  attempt int NOT NULL DEFAULT 0,
  -- Ordered slides of the latest generation: [{ "url": ..., "prompt": ... }, ...].
  result jsonb,
  preview_message_ids jsonb,
  preview_sent_at timestamptz,
  approved_at timestamptz,
  archived_at timestamptz,
  error_code text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_photo_replicator_jobs_user_status
  ON photo_replicator_jobs (user_id, status);

-- The same photo + character + format + slides + addition can be live only once.
-- failed/rejected rows drop out, so a re-tick can start it again.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_photo_replicator_jobs_active
  ON photo_replicator_jobs (user_id, source_sha256, character_id, format, slides, md5(coalesce(prompt_addition, '')))
  WHERE status NOT IN ('failed', 'rejected');

ALTER TABLE photo_replicator_jobs ENABLE ROW LEVEL SECURITY;

-- Queue job types: the generation worker and the farm's image repurpose.
ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'image_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_paste_finish', 'copy_paste_wan', 'copy_prompts_generate',
    'seedance_i2v', 'infinite_talk', 'nsfw_carousel_generate',
    'kling_recreate_v1',
    'photo_replicator', 'content_ops_image_repurpose'
  ));

-- The farm names archived files by Drive id; this finds their photo job.
CREATE INDEX IF NOT EXISTS idx_drive_exports_drive_file_id
  ON drive_exports (drive_file_id) WHERE drive_file_id IS NOT NULL;

INSERT INTO schema_migrations (name) VALUES ('106_photo_replicator') ON CONFLICT DO NOTHING;
