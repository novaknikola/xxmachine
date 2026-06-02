CREATE TABLE IF NOT EXISTS prompt_library (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  label        TEXT,           -- optional short name/tag
  tags         TEXT[],         -- e.g. ['NSFW', 'outdoor', 'selfie']
  used_count   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_library_character ON prompt_library(character_id);
CREATE INDEX IF NOT EXISTS idx_prompt_library_created   ON prompt_library(created_at DESC);
