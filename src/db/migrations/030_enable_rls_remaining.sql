-- 030 — Enable RLS on remaining public tables (Supabase advisor: rls_disabled_in_public)
--
-- App uses DATABASE_URL as postgres/service role → bypasses RLS.
-- No permissive policies on purpose: PostgREST/anon cannot read or write rows.

ALTER TABLE public.calendar_days            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatter_stats            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comfyui_templates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_source_mappings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_exports            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_folders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fan_assignments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_queue         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_downloader_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_downloader_reels      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loras                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_stats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reels_history            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reels_presets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_audios          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permissions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings            ENABLE ROW LEVEL SECURITY;
