-- Migration: v10_startup_contexts
-- Creates the startup_contexts table used by contextBuilder.js to persist
-- versioned, structured context objects derived from onboarding + Gemini inference.
--
-- Why this table exists:
--   Each intelligence run builds a Startup_Context (revenue profile, dependency map,
--   exposure weights, competitive map, etc.) and needs to store it so future runs can
--   do incremental delta-learning instead of starting cold.
--
--   Without this table the app throws:
--     GET /rest/v1/startup_contexts → 404
--     "[ContextBuilder] Fetch error: Could not find the table 'public.startup_contexts'"
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABLE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.startup_contexts (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  version_id            text,                                   -- e.g. "ctx_1718000000000_ab12cd34"
  revenue_profile       jsonb DEFAULT '{}'::jsonb,
  market_profile        jsonb DEFAULT '{}'::jsonb,
  dependency_map        jsonb DEFAULT '{}'::jsonb,
  competitive_map       jsonb DEFAULT '{}'::jsonb,
  strategic_assumptions jsonb DEFAULT '[]'::jsonb,
  exposure_weights      jsonb DEFAULT '{}'::jsonb,
  sensitivity_snapshot  jsonb DEFAULT '{}'::jsonb,
  onboarding_inputs     jsonb DEFAULT '{}'::jsonb,              -- raw founder-provided form data
  auto_inferred         jsonb DEFAULT '{}'::jsonb,              -- raw Gemini-inferred context
  created_at            timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. INDEX  (company_id + created_at — covers getLatestStartupContext query)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_startup_contexts_company_created
  ON public.startup_contexts (company_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.startup_contexts ENABLE ROW LEVEL SECURITY;

-- Admins: full access
DROP POLICY IF EXISTS "Admins all startup_contexts" ON public.startup_contexts;
CREATE POLICY "Admins all startup_contexts" ON public.startup_contexts
  FOR ALL
  USING (public.is_admin());

-- Authenticated client users: access only their own company's contexts
DROP POLICY IF EXISTS "clients all startup_contexts" ON public.startup_contexts;
CREATE POLICY "clients all startup_contexts" ON public.startup_contexts
  FOR ALL
  USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. VERIFICATION QUERY  (uncomment to test after running)
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT table_name, row_security
-- FROM information_schema.tables
-- LEFT JOIN pg_class ON relname = table_name
-- WHERE table_name = 'startup_contexts';
