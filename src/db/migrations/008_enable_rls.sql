-- 008 — Enable RLS on all public tables exposed via Supabase PostgREST
--
-- The app connects as the postgres/service role via DATABASE_URL (direct pg pool),
-- which bypasses RLS entirely — so these changes do NOT affect application behaviour.
-- RLS only blocks unauthenticated PostgREST/API access from external clients.

ALTER TABLE public.characters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_library   ENABLE ROW LEVEL SECURITY;

-- No permissive policies are added intentionally.
-- All access goes through the app's own API layer (Next.js route handlers),
-- never directly through PostgREST. Enabling RLS with no public policies
-- means PostgREST returns zero rows to any unauthenticated/anon request.
