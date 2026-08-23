-- Optional PPV price per scheduled Fanvue post, in integer cents (Fanvue's own unit).
alter table fanvue_scheduled_posts add column if not exists price_cents integer;
