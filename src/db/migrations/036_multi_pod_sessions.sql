-- 036 — Multi-pod My Pod: named sessions, job pin, workflow defaults

set search_path = public;

-- Surrogate PK + display name (migrate existing single-row sessions → "Default")
ALTER TABLE pod_sessions ADD COLUMN IF NOT EXISTS id uuid;
UPDATE pod_sessions SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE pod_sessions ALTER COLUMN id SET NOT NULL;
ALTER TABLE pod_sessions ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE pod_sessions ADD COLUMN IF NOT EXISTS name text;
UPDATE pod_sessions SET name = 'Default' WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE pod_sessions ALTER COLUMN name SET NOT NULL;
ALTER TABLE pod_sessions ALTER COLUMN name SET DEFAULT 'Default';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pod_sessions_pkey'
       AND conrelid = 'public.pod_sessions'::regclass
  ) THEN
    ALTER TABLE pod_sessions DROP CONSTRAINT pod_sessions_pkey;
  END IF;
END $$;

ALTER TABLE pod_sessions ADD PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS pod_sessions_user_name_uidx
  ON pod_sessions (user_id, name);
CREATE INDEX IF NOT EXISTS pod_sessions_user_id_idx
  ON pod_sessions (user_id);

CREATE TABLE IF NOT EXISTS pod_workflow_defaults (
  user_id                    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_talk_session_id    uuid REFERENCES pod_sessions(id) ON DELETE SET NULL,
  default_animate_session_id uuid REFERENCES pod_sessions(id) ON DELETE SET NULL,
  default_i2v_session_id     uuid REFERENCES pod_sessions(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE generation_queue
  ADD COLUMN IF NOT EXISTS pod_session_id uuid REFERENCES pod_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generation_queue_pod_session
  ON generation_queue (pod_session_id)
  WHERE pod_session_id IS NOT NULL;
