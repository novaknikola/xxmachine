-- 097 — Copy-Paste replication via Wan 3.0 reference-to-video, replacing the
-- Seedream-keyframe + Seedance-video-edit pipeline for new Telegram
-- submissions. Deliberately its own table, NOT another column bolt-on to
-- discovery_items: that table's UNIQUE(user_id, content_id) meant a second
-- attempt at the same reel (e.g. a different character) silently overwrote
-- the first one instead of coexisting — confirmed live 2026-09-20 as the
-- root cause of "always returns the same keyframe" even after the
-- awaiting_keyframe_approval status-reset fix (0a10de7/bfff9db). No unique
-- constraint here on purpose: every submission is its own row, so the same
-- reel can be replicated for any number of different characters, and the
-- full history is kept rather than overwritten. discovery_items itself is
-- untouched — it still backs the viral-monitor discovery feed and any
-- already-in-flight old-pipeline items.
CREATE TABLE IF NOT EXISTS copy_paste_wan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id text,
  profile text,
  content_url text NOT NULL,
  content_id text NOT NULL,
  video_url text,
  reference_image_url text NOT NULL,
  aspect_ratio text,
  source_duration numeric,
  status text NOT NULL DEFAULT 'awaiting_confirm'
    CHECK (status IN ('awaiting_confirm', 'generating', 'done', 'failed')),
  error text,
  video_result_url text,
  video_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copy_paste_wan_jobs_user_status
  ON copy_paste_wan_jobs(user_id, status);

INSERT INTO schema_migrations (name) VALUES ('097_copy_paste_wan_jobs') ON CONFLICT DO NOTHING;
