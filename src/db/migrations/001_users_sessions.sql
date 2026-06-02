-- 001 — users + sessions

create extension if not exists "pgcrypto";

create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  display_name    text not null,
  role            text not null check (role in ('admin', 'chatter')),
  password_hash   text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

create index if not exists idx_users_email_lower on users (lower(email));

create table if not exists sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  ip              text,
  user_agent      text
);

create index if not exists idx_sessions_user on sessions (user_id);
create index if not exists idx_sessions_expires on sessions (expires_at);

-- Track applied migrations
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
