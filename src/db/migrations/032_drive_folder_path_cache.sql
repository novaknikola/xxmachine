-- 032 — Cache every Drive path segment (not only leaf) to prevent duplicate folders.
-- Unique key becomes (user_id, path), e.g. "yanna", "yanna/carousel", "yanna/carousel/ready/2026-07-28".

ALTER TABLE drive_folders
  ADD COLUMN IF NOT EXISTS path TEXT;

DELETE FROM drive_folders;

ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_date_unique;

ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_stage_unique;

ALTER TABLE drive_folders
  DROP CONSTRAINT IF EXISTS drive_folders_user_id_character_key_kind_model_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS drive_folders_user_path_uidx
  ON drive_folders (user_id, path);
