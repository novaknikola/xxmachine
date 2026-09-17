-- 090 — Seedance recreate: first/end frame via Nano Banana Pro Edit.
--
-- Character still generation switches from Seedream Edit (image1=scene ref,
-- image2=identity ref) to Nano Banana Pro Edit generating TWO stills: the
-- first frame (identity reference photo alone) and the end frame (identity
-- reference photo + the just-generated first frame, for wardrobe/scene
-- continuity, not just identity). Both are shown together at the still-
-- approval gate; approving one action confirms both.
--
-- character_image_url (existing column) keeps holding the first-frame
-- result — no rename, avoids touching already-shaped data. end_frame_
-- image_url is new. first_frame_prompt/last_frame_prompt store the built
-- Nano Banana Pro prompts so they can be redisplayed/reused without
-- re-calling Grok (same role seedance_prompt already has for the Seedance
-- prompt itself).

ALTER TABLE kling_recreate_jobs
  ADD COLUMN IF NOT EXISTS end_frame_image_url TEXT,
  ADD COLUMN IF NOT EXISTS first_frame_prompt TEXT,
  ADD COLUMN IF NOT EXISTS last_frame_prompt TEXT;

INSERT INTO schema_migrations (name) VALUES ('090_seedance_keyframes') ON CONFLICT DO NOTHING;
