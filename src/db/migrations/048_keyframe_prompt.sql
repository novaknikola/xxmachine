-- 048 — Keep the Seedream keyframe prompt.
--
-- rendered_prompt has always held the Seedance (video) prompt, and the keyframe
-- prompt — the one that actually decides how the person looks — was built at
-- render time and thrown away. So when a keyframe came back with the wrong hair
-- or borrowed tattoos, there was nothing to read: the only evidence was the
-- image itself. These columns record what was sent.

alter table discovery_items add column if not exists keyframe_prompt text;
alter table discovery_items add column if not exists end_keyframe_prompt text;

insert into schema_migrations (name) values ('048_keyframe_prompt') on conflict do nothing;
