CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id UUID NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  fanvue_user_uuid TEXT NOT NULL,
  text TEXT DEFAULT '',
  price NUMERIC DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  custom_list_uuid TEXT,
  mass_message_uuid TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_fan_status
ON scheduled_messages(fan_id, status, scheduled_at);

INSERT INTO schema_migrations (name)
VALUES ('013_scheduled_messages')
ON CONFLICT DO NOTHING;