-- 076 — Isolated Instagram viral monitor (Google Sheet profile list → daily
-- Telegram report of newly-viral Reels). Self-contained: no FKs to users/
-- tracked_profiles/discovery_items, so it can't be broken by or break those.

CREATE TABLE IF NOT EXISTS viral_monitor_videos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_username TEXT NOT NULL,
  shortcode        TEXT,
  video_url        TEXT NOT NULL UNIQUE,
  posted_at        TIMESTAMPTZ,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at  TIMESTAMPTZ,
  last_views       BIGINT,
  reported_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viral_monitor_videos_profile ON viral_monitor_videos (profile_username);
CREATE INDEX IF NOT EXISTS idx_viral_monitor_videos_unreported ON viral_monitor_videos (reported_at) WHERE reported_at IS NULL;

CREATE TABLE IF NOT EXISTS viral_monitor_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  video_id   UUID NOT NULL REFERENCES viral_monitor_videos(id) ON DELETE CASCADE,
  views      BIGINT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viral_monitor_snapshots_video ON viral_monitor_snapshots (video_id, checked_at);

CREATE TABLE IF NOT EXISTS viral_monitor_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  profiles_total  INTEGER,
  profiles_failed INTEGER,
  videos_scanned  INTEGER,
  videos_new      INTEGER,
  viral_new       INTEGER,
  error           TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_viral_monitor_runs_started ON viral_monitor_runs (started_at DESC);

INSERT INTO schema_migrations (name) VALUES ('076_viral_monitor') ON CONFLICT DO NOTHING;
