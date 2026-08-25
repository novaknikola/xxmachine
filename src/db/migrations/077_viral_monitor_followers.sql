-- 077 — Follower-ratio viral condition: a video also qualifies as viral when
-- views >= followers * VIRAL_MONITOR_FOLLOWERS_MULTIPLIER, alongside the
-- existing flat VIRAL_MONITOR_VIEWS_THRESHOLD rule.

ALTER TABLE viral_monitor_videos ADD COLUMN IF NOT EXISTS followers BIGINT;

INSERT INTO schema_migrations (name) VALUES ('077_viral_monitor_followers') ON CONFLICT DO NOTHING;
