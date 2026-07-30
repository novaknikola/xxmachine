-- 035 — My Pod: Fish API key stored encrypted on pod_sessions (UI, not env)

set search_path = public;

ALTER TABLE pod_sessions
  ADD COLUMN IF NOT EXISTS fish_api_key_enc text;
