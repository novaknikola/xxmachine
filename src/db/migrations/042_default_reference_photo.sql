-- 042 — Account-wide default reference photo for Copy-Paste.
--
-- Scan-created discovery_items have no per-batch reference photo, so the daily
-- viral farm (approve in Discovery → replicate) had nothing to put a face on.
-- The per-batch upload still wins when present; this is only the fallback.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_reference_image_url TEXT;
