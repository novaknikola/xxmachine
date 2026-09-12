-- 084 — Kling 3.0 recreate pipeline for @contentreplicatorbot.
--
-- Adds generation_queue job_type kling_recreate_v1, user-scoped analysis /
-- render tables, a persistent idea bank, per-user Kling settings, and
-- rewrites telegram_recreate_pending from the old pose-recreate
-- format/count/carousel collect state to photo + reel URLs.

ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'image_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate', 'my_pod_talk',
    'copy_paste_v2', 'copy_prompts_generate',
    'seedance_i2v', 'infinite_talk', 'nsfw_carousel_generate',
    'kling_recreate_v1'
  ));

CREATE TABLE IF NOT EXISTS kling_recreate_settings (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  variant          TEXT NOT NULL DEFAULT 'pro' CHECK (variant IN ('std', 'pro', '4k')),
  duration_mode    TEXT NOT NULL DEFAULT 'auto' CHECK (duration_mode IN ('auto', 'fixed')),
  duration_sec     INT CHECK (duration_sec IS NULL OR (duration_sec BETWEEN 3 AND 15)),
  sound            BOOLEAN NOT NULL DEFAULT true,
  cfg_scale        NUMERIC NOT NULL DEFAULT 0.5 CHECK (cfg_scale >= 0 AND cfg_scale <= 1),
  shot_type        TEXT NOT NULL DEFAULT 'customize' CHECK (shot_type IN ('customize', 'intelligence')),
  negative_prompt  TEXT,
  element_list     TEXT[] NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kling_recreate_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  queue_job_id         UUID REFERENCES generation_queue(id) ON DELETE SET NULL,
  chat_id              BIGINT,
  source_url           TEXT NOT NULL,
  video_url            TEXT,
  duration_sec         NUMERIC,
  reference_image_url  TEXT,
  context              JSONB,
  master_prompt        TEXT,
  character_image_url  TEXT,
  kling_video_url      TEXT,
  kling_variant        TEXT,
  kling_request        JSONB,
  settings             JSONB NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scraping', 'analyzing', 'still', 'rendering', 'done', 'failed')),
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kling_recreate_jobs_user
  ON kling_recreate_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kling_recreate_jobs_queue
  ON kling_recreate_jobs (queue_job_id);

CREATE TABLE IF NOT EXISTS kling_recreate_frames (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES kling_recreate_jobs(id) ON DELETE CASCADE,
  t_sec        NUMERIC NOT NULL,
  image_url    TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, t_sec)
);

CREATE INDEX IF NOT EXISTS idx_kling_recreate_frames_job
  ON kling_recreate_frames (job_id, t_sec);

CREATE TABLE IF NOT EXISTS kling_idea_bank (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES kling_recreate_jobs(id) ON DELETE SET NULL,
  niche             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  uniqueness_hash   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, uniqueness_hash)
);

CREATE INDEX IF NOT EXISTS idx_kling_idea_bank_user
  ON kling_idea_bank (user_id, created_at DESC);

DROP TABLE IF EXISTS telegram_recreate_pending;

CREATE TABLE telegram_recreate_pending (
  chat_id      BIGINT PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  photo_url    TEXT,
  urls         TEXT[] NOT NULL DEFAULT '{}',
  awaiting     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE kling_recreate_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kling_recreate_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kling_recreate_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE kling_idea_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_recreate_pending ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('084_kling_recreate_v1') ON CONFLICT DO NOTHING;
