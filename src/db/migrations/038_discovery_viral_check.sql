-- 038 — Viral re-check fields on discovery_items: detect a view-count spike on
-- an already-tracked post between scans, instead of only ever inserting new posts.

ALTER TABLE discovery_items
  ADD COLUMN IF NOT EXISTS views_at_last_check bigint,
  ADD COLUMN IF NOT EXISTS checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS viral_alerted_at timestamptz;
