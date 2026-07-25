CREATE TABLE IF NOT EXISTS content_source_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_name TEXT NOT NULL UNIQUE,
  instagram_account_id UUID REFERENCES instagram_accounts(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_source_mappings_sheet_name
ON content_source_mappings (lower(sheet_name));

CREATE INDEX IF NOT EXISTS idx_content_source_mappings_account
ON content_source_mappings (instagram_account_id);

INSERT INTO schema_migrations (name)
VALUES ('015_content_source_mappings')
ON CONFLICT DO NOTHING;
