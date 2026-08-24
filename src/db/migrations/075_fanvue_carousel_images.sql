-- Fanvue posts can carry more than one media item (a carousel). `image_url` stays the
-- cover/first image for backward compatibility with every existing single-image row;
-- the rest live here, in display order.
alter table fanvue_scheduled_posts add column if not exists extra_image_urls text[];
