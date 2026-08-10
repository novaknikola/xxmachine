CREATE TABLE IF NOT EXISTS instagram_auto_schedule_runs (
  run_date       DATE PRIMARY KEY,
  items_created  INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (name)
VALUES ('064_ig_auto_schedule_runs')
ON CONFLICT DO NOTHING;
