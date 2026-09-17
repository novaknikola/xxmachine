-- 089 — Seedance recreate: dialogue-attribution gate + Seedance prompt column.
--
-- Swaps the render step from Kling 3.0 to Seedance 2.5 (see
-- D:\VScode\reels-analiza\docs\SEEDANCE-2.5-I2V.md and the plan doc for the
-- full swap) and inserts a new pause point between the existing two gates:
--   'awaiting_still_approval'    — unchanged, after the character still.
--   'awaiting_dialogue_approval' — NEW. Before the Seedance prompt is even
--                                  built, a human confirms the compact
--                                  "who says what" list — catching a
--                                  speaker-attribution mistake here is far
--                                  cheaper than after prompt synthesis + a
--                                  paid render. Only the short line list is
--                                  shown, never the full prompt.
--   'awaiting_prompt_approval'   — unchanged in spirit, now approves the
--                                  Seedance prompt instead of the Kling one.
--
-- seedance_prompt stores the built prompt text once the dialogue gate is
-- passed, so the prompt-approval message and a later regenerate don't need
-- to re-call Grok just to redisplay it. confirmed_dialogue stores the user's
-- free-text speaker correction, if they sent one, so it can be folded back
-- into prompt synthesis with top priority.
--
-- Kling-only settings (variant/cfg_scale/sound/shot_type/negative_prompt/
-- element_list) are no longer read or written by the app — the
-- kling_recreate_settings table and the settings column on
-- kling_recreate_jobs are deliberately left in place rather than dropped,
-- per the plan doc (dropping a table with live-shaped data is a separate,
-- higher-risk step not taken here).

ALTER TABLE kling_recreate_jobs
  ADD COLUMN IF NOT EXISTS seedance_prompt TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_dialogue TEXT;

ALTER TABLE kling_recreate_jobs DROP CONSTRAINT IF EXISTS kling_recreate_jobs_status_check;
ALTER TABLE kling_recreate_jobs ADD CONSTRAINT kling_recreate_jobs_status_check
  CHECK (status IN (
    'pending', 'scraping', 'analyzing', 'still',
    'awaiting_still_approval', 'awaiting_dialogue_approval', 'awaiting_prompt_approval',
    'rendering', 'done', 'failed'
  ));

INSERT INTO schema_migrations (name) VALUES ('089_seedance_dialogue_gate') ON CONFLICT DO NOTHING;
