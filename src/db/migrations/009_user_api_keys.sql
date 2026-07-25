-- 009 — user API keys (BYOK) + plan tier on users

-- Add plan column to users
alter table users add column if not exists plan text not null default 'free'
  check (plan in ('free', 'pro'));

alter table users add column if not exists stripe_customer_id text;
alter table users add column if not exists stripe_subscription_id text;
alter table users add column if not exists plan_expires_at timestamptz;

-- Per-user encrypted API keys (Bring Your Own Key)
create table if not exists user_api_keys (
  user_id   uuid not null references users(id) on delete cascade,
  key_name  text not null,
  key_enc   text not null,  -- AES-256-GCM encrypted, base64: iv:tag:ciphertext
  updated_at timestamptz not null default now(),
  primary key (user_id, key_name)
);

create index if not exists idx_user_api_keys_user on user_api_keys(user_id);

