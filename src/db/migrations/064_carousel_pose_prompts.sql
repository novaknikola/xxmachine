-- 064 — large random pool of carousel pose-edit prompts (pose-recreate bot),
-- replacing the small hardcoded CAROUSEL_POSE_VARIANTS list. Seeded from the
-- existing carousel-presets.ts prompts, expanded via Grok.
CREATE TABLE IF NOT EXISTS carousel_pose_prompts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_text TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'grok' CHECK (source IN ('preset', 'grok')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carousel_pose_prompts_active
  ON carousel_pose_prompts (active);

INSERT INTO schema_migrations (name) VALUES ('064_carousel_pose_prompts') ON CONFLICT DO NOTHING;
