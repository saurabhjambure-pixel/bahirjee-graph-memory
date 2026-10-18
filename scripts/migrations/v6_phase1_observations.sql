-- ==========================================
-- BAHIRJEE v6.0 — PHASE 1: OBSERVATIONS TABLE
-- ==========================================
-- Run this in your Supabase SQL Editor.
-- Observations store ALL raw Tavily + Firecrawl findings.
-- They are internal (not shown to users) and persist across runs.

-- 1. Create the observations table
CREATE TABLE IF NOT EXISTS public.observations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  run_id uuid NOT NULL,            -- groups observations from a single run
  theme text NOT NULL,             -- query category (competitor_intel, talent_signals, etc.)
  entity text,                     -- company/entity being observed
  source_url text,                 -- URL of the source
  source_type text NOT NULL CHECK (source_type IN ('tavily', 'firecrawl')),
  raw_text text NOT NULL,          -- full text content
  timestamp timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_observations_company_id ON public.observations(company_id);
CREATE INDEX IF NOT EXISTS idx_observations_theme ON public.observations(theme);
CREATE INDEX IF NOT EXISTS idx_observations_run_id ON public.observations(run_id);
CREATE INDEX IF NOT EXISTS idx_observations_created_at ON public.observations(created_at);

-- 3. Enable Row Level Security
ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
-- Admins can do everything
DROP POLICY IF EXISTS "Admins all observations" ON public.observations;
CREATE POLICY "Admins all observations" ON public.observations FOR ALL
USING (public.is_admin());

-- Client users can view their own company's observations
DROP POLICY IF EXISTS "Users view own observations" ON public.observations;
CREATE POLICY "Users view own observations" ON public.observations FOR SELECT
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

-- Client users can insert observations for their own company
DROP POLICY IF EXISTS "Users insert own observations" ON public.observations;
CREATE POLICY "Users insert own observations" ON public.observations FOR INSERT
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);
