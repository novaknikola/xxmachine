CREATE TABLE IF NOT EXISTS calendar_days (
  id TEXT PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  topic TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  description TEXT DEFAULT '',
  fanvue_description TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  prompts JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'empty',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(character_id, date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_days_character_date
ON calendar_days(character_id, date);

CREATE TABLE IF NOT EXISTS fan_assignments (
  fan_uuid TEXT NOT NULL,
  creator_uuid TEXT NOT NULL,
  chatter_id TEXT NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT DEFAULT '',
  PRIMARY KEY (fan_uuid, creator_uuid)
);

CREATE INDEX IF NOT EXISTS idx_fan_assignments_chatter
ON fan_assignments(chatter_id);

CREATE INDEX IF NOT EXISTS idx_fan_assignments_creator
ON fan_assignments(creator_uuid);

CREATE TABLE IF NOT EXISTS chatter_stats (
  id TEXT PRIMARY KEY,
  chatter_id TEXT NOT NULL,
  date TEXT NOT NULL,
  messages_sent INTEGER DEFAULT 0,
  ppv_sent INTEGER DEFAULT 0,
  ppv_revenue NUMERIC DEFAULT 0,
  fans_assigned INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(chatter_id, date)
);

CREATE INDEX IF NOT EXISTS idx_chatter_stats_chatter_date
ON chatter_stats(chatter_id, date);

INSERT INTO schema_migrations (name)
VALUES ('010_calendar_fan_assignments')
ON CONFLICT DO NOTHING;