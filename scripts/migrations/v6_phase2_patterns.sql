-- ==========================================
-- BAHIRJEE v6.0 — PHASE 2: PATTERNS TABLE
-- ==========================================
-- Run this in your Supabase SQL Editor AFTER Phase 1 migration.
-- Patterns are deterministic clusters of Observations.
-- They persist and UPDATE across runs (never recreated).

-- 1. Create the patterns table
CREATE TABLE IF NOT EXISTS public.patterns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  theme text NOT NULL,                   -- cluster theme (competitor_intel, talent_signals, etc.)
  entity_cluster text[] DEFAULT '{}',    -- array of entity names in this cluster
  observation_ids uuid[] DEFAULT '{}',   -- linked observation IDs
  observation_count integer DEFAULT 0,
  source_diversity integer DEFAULT 0,    -- unique source domains
  first_seen timestamptz DEFAULT now(),
  last_seen timestamptz DEFAULT now(),
  velocity_score numeric(5,2) DEFAULT 0, -- observations in last 7d / prior 23d
  maturity text DEFAULT 'early' CHECK (maturity IN ('early', 'forming', 'established')),
  updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,

  -- Composite unique: one pattern per company + theme
  CONSTRAINT unique_company_theme UNIQUE (company_id, theme)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_patterns_company_id ON public.patterns(company_id);
CREATE INDEX IF NOT EXISTS idx_patterns_maturity ON public.patterns(maturity);
CREATE INDEX IF NOT EXISTS idx_patterns_velocity ON public.patterns(velocity_score);

-- 3. Enable RLS
ALTER TABLE public.patterns ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
DROP POLICY IF EXISTS "Admins all patterns" ON public.patterns;
CREATE POLICY "Admins all patterns" ON public.patterns FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Users view own patterns" ON public.patterns;
CREATE POLICY "Users view own patterns" ON public.patterns FOR SELECT
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Users upsert own patterns" ON public.patterns;
CREATE POLICY "Users upsert own patterns" ON public.patterns FOR INSERT
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Users update own patterns" ON public.patterns;
CREATE POLICY "Users update own patterns" ON public.patterns FOR UPDATE
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);
