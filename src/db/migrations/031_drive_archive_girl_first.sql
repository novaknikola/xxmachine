-- 031 — Girl-first Drive layout: character / format / stage / date
-- Path no longer includes AI model (model goes in filename).
-- date_key groups uploads by day under ready/ and raw/.

ALTER TABLE drive_folders
  ADD COLUMN IF NOT EXISTS date_key TEXT NOT NULL DEFAULT '';

ALTER TABLE drive_exports
  ADD COLUMN IF NOT EXISTS date_key TEXT NOT NULL DEFAULT '';

ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_stage_unique;

ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_id_character_key_kind_model_key_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drive_folders_user_date_unique'
  ) THEN
    ALTER TABLE drive_folders
      ADD CONSTRAINT drive_folders_user_date_unique
      UNIQUE (user_id, character_key, kind, stage, date_key);
  END IF;
END $$;

-- Old leaf folders pointed at …/model — clear cache so new date leaves are created.
DELETE FROM drive_folders;
