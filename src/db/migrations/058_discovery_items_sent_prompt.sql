-- 058 — The exact prompt actually sent to Seedance for the video call,
-- including any Telegram /prompt text appended to rendered_prompt at
-- generation time. rendered_prompt stays the editable base; this is the
-- read-only record of what really went out, so "did my extra text apply?"
-- has a checkable answer instead of just trusting the code path.

alter table discovery_items
  add column if not exists sent_prompt text;

insert into schema_migrations (name) values ('058_discovery_items_sent_prompt')
  on conflict do nothing;
