-- Drive archive: content format folders use stage (ready/raw) under character.

ALTER TABLE drive_folders
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE drive_exports
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'ready';

-- Replace unique key so the same model can exist under ready/ and raw/.
ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_id_character_key_kind_model_key_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drive_folders_user_stage_unique'
  ) THEN
    ALTER TABLE drive_folders
      ADD CONSTRAINT drive_folders_user_stage_unique
      UNIQUE (user_id, character_key, kind, stage, model_key);
  END IF;
END $$;

INSERT INTO schema_migrations (name)
VALUES ('029_drive_archive_stage')
ON CONFLICT DO NOTHING;
