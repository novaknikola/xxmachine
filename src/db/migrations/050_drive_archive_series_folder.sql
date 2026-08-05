-- 050 — Per-set Drive subfolder (one folder per carousel).
--
-- The Drive worker only ever sees drive_exports columns (see claimNextExport in
-- lib/drive-archive/process.ts), so the subfolder segment has to travel on the
-- row. The user's label itself does NOT need a column: it is already baked into
-- `filename` at enqueue time.
--
-- '' (the default) means "no subfolder" and reproduces the previous layout
-- exactly, so every row queued before this migration keeps uploading to
-- .../{stage}/{date}/ as it would have.

alter table drive_exports add column if not exists series_folder text not null default '';

-- Deliberately NOT clearing drive_folders (031 and 032 both did): this change
-- only ever appends a deeper path, so every cached ancestor folder id is still
-- correct and re-resolving them would cost a Drive round-trip per user.

insert into schema_migrations (name) values ('050_drive_archive_series_folder') on conflict do nothing;
