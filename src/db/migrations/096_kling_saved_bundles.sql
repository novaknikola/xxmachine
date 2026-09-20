-- 096 — Saved character/ambiance "bundles" for the recreate bot: a named
-- snapshot of reference_photos + ambiance_photo_url the user can reload with
-- one tap instead of re-uploading the same photos for every new batch.
-- See the plan doc.

CREATE TABLE IF NOT EXISTS kling_saved_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  reference_photos jsonb NOT NULL DEFAULT '{}'::jsonb,
  ambiance_photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

INSERT INTO schema_migrations (name) VALUES ('096_kling_saved_bundles') ON CONFLICT DO NOTHING;
