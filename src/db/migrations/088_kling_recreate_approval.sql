-- 088 — Kling recreate: photo + prompt approval gates, shot-mode choice, custom still prompt.
--
-- The pipeline used to go straight from "character still generated" into the
-- paid Kling 3.0 i2v call with no human check. Two new pause points:
--   'awaiting_still_approval'  — after the Seedream character still, before
--                                the final Kling prompt/shots are even built.
--   'awaiting_prompt_approval' — after the still is approved and the actual
--                                Kling prompt/multi_prompt is assembled
--                                (including, for multi-shot, a per-shot
--                                character still each), before the paid
--                                Kling call fires.
-- shot_mode is chosen by the user up front (before analysis even runs) —
-- carried from telegram_recreate_pending onto the job at creation, since it
-- changes how the still-generation step behaves (one still vs one per shot).
-- custom_prompt is optional free text the user can add before the character
-- still is generated, appended to renderRecreateKeyframePrompt.

ALTER TABLE telegram_recreate_pending
  ADD COLUMN IF NOT EXISTS shot_mode TEXT CHECK (shot_mode IS NULL OR shot_mode IN ('one_shot', 'multi_shot')),
  ADD COLUMN IF NOT EXISTS custom_prompt TEXT;

ALTER TABLE kling_recreate_jobs
  ADD COLUMN IF NOT EXISTS shot_mode TEXT CHECK (shot_mode IS NULL OR shot_mode IN ('one_shot', 'multi_shot')),
  ADD COLUMN IF NOT EXISTS custom_prompt TEXT,
  -- One still per shot for multi-shot mode (t_sec keyed, mirrors kling_recreate_frames' shape).
  ADD COLUMN IF NOT EXISTS shot_stills JSONB;

ALTER TABLE kling_recreate_jobs DROP CONSTRAINT IF EXISTS kling_recreate_jobs_status_check;
ALTER TABLE kling_recreate_jobs ADD CONSTRAINT kling_recreate_jobs_status_check
  CHECK (status IN (
    'pending', 'scraping', 'analyzing', 'still',
    'awaiting_still_approval', 'awaiting_prompt_approval',
    'rendering', 'done', 'failed'
  ));

INSERT INTO schema_migrations (name) VALUES ('088_kling_recreate_approval') ON CONFLICT DO NOTHING;
