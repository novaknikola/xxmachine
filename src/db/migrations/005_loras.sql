-- 005 — LoRA library

CREATE TABLE IF NOT EXISTS loras (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  trigger_word          TEXT,
  lora_url              TEXT,
  status                TEXT NOT NULL DEFAULT 'training'
                          CHECK (status IN ('training', 'ready', 'failed')),
  steps                 INTEGER NOT NULL DEFAULT 1000,
  learning_rate         FLOAT NOT NULL DEFAULT 0.0001,
  lora_rank             INTEGER NOT NULL DEFAULT 16,
  wavespeed_request_id  TEXT,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loras_status ON loras (status);
CREATE INDEX IF NOT EXISTS idx_loras_created ON loras (created_at DESC);

INSERT INTO schema_migrations (name) VALUES ('005_loras') ON CONFLICT DO NOTHING;
