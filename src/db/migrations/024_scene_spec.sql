-- Structured scene capture for replication prompts (body, wardrobe, pose, hook, speech).

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS scene_spec jsonb;

INSERT INTO schema_migrations (name) VALUES ('024_scene_spec') ON CONFLICT DO NOTHING;
