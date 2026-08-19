-- 069 — Drop content_engine_ideas (068). Same session, superseded before ever deploying:
-- topic-only idea history is replaced by a "History" toggle over the existing
-- content_engine_scripts list (title + full generated script), which already covers "reuse a
-- script that went viral" better than a bare topic string does.

drop table if exists content_engine_ideas;

insert into schema_migrations (name) values ('069_drop_content_engine_ideas') on conflict do nothing;
