-- 083 — thumbnail preview for facebook_queue, so the Reels queue list shows
-- the actual first frame instead of just a filename like IMG_0003.mp4.
-- Stored as a small base64 data URI directly on the row (queue sizes here
-- are tens of items, not thousands) rather than a separate serving route.

alter table facebook_queue add column if not exists thumbnail_url text;

insert into schema_migrations (name) values ('083_facebook_queue_thumbnail') on conflict do nothing;
