-- 033 — My Pod sessions + job types for I2V / Animate control plane

set search_path = public;

CREATE TABLE IF NOT EXISTS pod_sessions (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  comfy_base_url       text NOT NULL,
  ssh_host             text NOT NULL,
  ssh_port             int  NOT NULL DEFAULT 22,
  ssh_user             text NOT NULL DEFAULT 'root',
  ssh_auth_type        text NOT NULL CHECK (ssh_auth_type IN ('password', 'private_key')),
  ssh_auth_enc         text NOT NULL,
  comfy_api_token_enc  text,
  remote_work_root     text NOT NULL DEFAULT '/workspace/xxmachine',
  last_ok_at           timestamptz,
  last_error           text,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pod_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE generation_queue DROP CONSTRAINT IF EXISTS generation_queue_job_type_check;
ALTER TABLE generation_queue ADD CONSTRAINT generation_queue_job_type_check
  CHECK (job_type IN (
    'bulk_image', 'video_repurpose', 'video_caption', 'video_transcribe',
    'comfyui_pod_bulk', 'video_ocr', 'caption_shuffle', 'caption_generate',
    'bulk_carousel', 'monitor_multi_shot',
    'my_pod_i2v', 'my_pod_animate'
  ));
