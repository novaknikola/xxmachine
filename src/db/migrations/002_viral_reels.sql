-- 002 — Instagram viral reel tracker

CREATE TABLE IF NOT EXISTS tracked_profiles (
  id         SERIAL PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS viral_reels (
  id                    SERIAL PRIMARY KEY,
  profile               TEXT NOT NULL,
  reel_url              TEXT NOT NULL UNIQUE,
  views                 INTEGER NOT NULL,
  posted_at             TIMESTAMPTZ NOT NULL,
  thumbnail_url         TEXT,
  video_url             TEXT,
  gemini_prompt         TEXT,
  generated_image_url   TEXT,
  kling_video_url       TEXT,
  status                TEXT NOT NULL DEFAULT 'viral_detected',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viral_reels_status ON viral_reels (status);
CREATE INDEX IF NOT EXISTS idx_viral_reels_created ON viral_reels (created_at DESC);

INSERT INTO schema_migrations (name) VALUES ('002_viral_reels') ON CONFLICT DO NOTHING;
