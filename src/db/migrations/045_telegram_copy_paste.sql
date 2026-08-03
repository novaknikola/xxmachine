-- 045 — Copy-Paste from Telegram: the batch being assembled in a chat.
--
-- Telegram delivers the reference photo and the reel links as separate
-- messages, in whatever order the user sends them, so the bot needs somewhere
-- to hold a half-built request between messages. One open batch per chat: a new
-- photo starts a fresh one, links accumulate onto it, and the approve button
-- hands it to the normal Copy-Paste queue.

create table if not exists telegram_batches (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  chat_id             text not null,
  reference_image_url text,
  urls                text[] not null default '{}',
  -- collecting → the user is still adding; submitted → handed to the queue.
  status              text not null default 'collecting'
                        check (status in ('collecting', 'submitted', 'cancelled')),
  -- Telegram message showing the summary, so its buttons can be cleared once
  -- the batch is acted on and cannot be pressed twice.
  prompt_message_id   bigint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- At most one batch per chat is still being assembled; everything else is
-- history. A partial unique index expresses that without blocking past batches.
create unique index if not exists idx_telegram_batches_open
  on telegram_batches (chat_id) where status = 'collecting';

create index if not exists idx_telegram_batches_user
  on telegram_batches (user_id, created_at desc);

insert into schema_migrations (name) values ('045_telegram_copy_paste')
  on conflict do nothing;
