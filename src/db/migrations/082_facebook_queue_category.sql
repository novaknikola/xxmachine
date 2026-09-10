-- 082 — tagging support for facebook_queue, mirrors instagram_queue.category.

alter table facebook_queue add column if not exists category text;

create index if not exists idx_facebook_queue_category on facebook_queue (category);

insert into schema_migrations (name) values ('082_facebook_queue_category') on conflict do nothing;
