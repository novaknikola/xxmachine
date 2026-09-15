-- 087 — Repurpose Drive uploads: group by variation + iPhone naming.
--
-- image_repurpose / video_repurpose used to dump every variant flat into
-- outputDriveFolderId as "<name>_001.jpg".."_00N.jpg". A batch of many source
-- files sharing one output folder (e.g. a whole persona's worth of posts)
-- landed as one giant flat pile with no way to tell "variant 1 of every
-- file" apart from "variant 2 of every file" — exactly the manual sorting
-- job that had to be done by hand for the 2026-09-15 diana batch. Now each
-- variant index gets its own "Package_N_of_COUNT" subfolder, files renamed
-- IMG_0001.ext sequentially within it, so folder N is a single complete,
-- ready-to-post set. The counter must be atomic across concurrent uploads
-- (multiple source files' jobs can write into the same subfolder at once).

CREATE TABLE IF NOT EXISTS drive_upload_sequences (
  folder_id   TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counter     INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (name) VALUES ('087_drive_repurpose_grouping') ON CONFLICT DO NOTHING;
