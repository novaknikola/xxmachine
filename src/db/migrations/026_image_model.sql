-- 026 — Per-item image generator choice for Copy-Paste / monitor replicate
ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS image_model text;

COMMENT ON COLUMN discovery_items.image_model IS
  'Image backend used for keyframes: z_image | seedream_edit';
