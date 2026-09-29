-- 103 — Optional top-level section folder in the Drive archive, e.g.
-- XXMachine Archives/IGreplicator/<character>/... for Replicator output.
-- '' keeps the old <character>/... layout for everything else.

ALTER TABLE drive_exports
  ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '';

INSERT INTO schema_migrations (name) VALUES ('103_drive_archive_section') ON CONFLICT DO NOTHING;
