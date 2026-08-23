-- Every caption Grok writes gets saved here automatically, so a caption can be reused
-- ("spun") on a different photo later without paying for another Grok call.
create table if not exists fanvue_caption_library (
  id uuid primary key default gen_random_uuid(),
  caption text not null,
  category text,
  structure text,
  content_level text,
  price_cents integer,
  source_image_url text,
  created_at timestamptz not null default now()
);

create index if not exists fanvue_caption_library_created_idx
  on fanvue_caption_library (created_at desc);
