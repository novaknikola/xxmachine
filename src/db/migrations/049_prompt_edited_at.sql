-- 049 — Mark a rendered_prompt a human actually touched.
--
-- Re-analyze rewrites rendered_prompt from the fresh spec, which must not silently
-- discard a hand-edited one. Re-rendering the stored spec and comparing cannot tell
-- an edit from renderer drift: NEGATIVE_PROMPT_TEMPLATE has been extended since most
-- rows were written and normalizeCopyPasteSpec always substitutes the current
-- constant, so 19 of 23 existing rows already fail to reproduce byte-for-byte.

alter table discovery_items add column if not exists prompt_edited_at timestamptz;

insert into schema_migrations (name) values ('049_prompt_edited_at') on conflict do nothing;
