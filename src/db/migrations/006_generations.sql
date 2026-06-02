CREATE TABLE IF NOT EXISTS generations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL DEFAULT 'text2img',   -- 'text2img' | 'wan_edit'
  character_id TEXT,
  character_name TEXT,
  prompt       TEXT NOT NULL,
  dimension    TEXT,
  batch        INTEGER DEFAULT 1,
  image_urls   TEXT[] NOT NULL DEFAULT '{}',       -- permanent Supabase Storage URLs
  user_id      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generations_user_id   ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_generations_created   ON generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_kind      ON generations(kind);
