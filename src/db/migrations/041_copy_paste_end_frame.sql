-- 041 — Copy-Paste end-frame variant. Seedance 2.0's image-to-video endpoint
-- takes an optional `last_image`, so the clip can be pinned at both ends.
--
-- The raw source last frame cannot be sent directly: it still carries the
-- original person's face, which would morph the subject back mid-clip. It gets
-- its own Seedream Edit pass, chained to the start keyframe so wardrobe/hair
-- stay identical across both ends. That second render reuses the existing
-- generated_end_image_url column (added in 022, unused since the rebuild).

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS source_last_frame_url text;
