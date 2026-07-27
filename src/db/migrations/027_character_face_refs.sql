-- Face reference photos for Seedream Edit in Copy-Paste (and similar identity swaps).
ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS face_ref_urls TEXT[] NOT NULL DEFAULT '{}';

INSERT INTO schema_migrations (name)
VALUES ('027_character_face_refs')
ON CONFLICT DO NOTHING;
