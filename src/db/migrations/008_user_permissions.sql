CREATE TABLE IF NOT EXISTS user_permissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, module_name)
);

INSERT INTO schema_migrations (name)
VALUES ('008_user_permissions')
ON CONFLICT DO NOTHING;