-- ==========================================
-- BAHIRJEE v6.0 — PHASE 4: BLIND SPOTS & OPPORTUNITIES TABLES
-- ==========================================
-- Run in Supabase SQL Editor AFTER Phase 3 migration.

-- 1. Blind Spots table
CREATE TABLE IF NOT EXISTS public.blind_spots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  pattern_id uuid REFERENCES public.patterns(id) ON DELETE CASCADE NOT NULL,
  theme text NOT NULL,
  competitor_entities text[] DEFAULT '{}',
  detected_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  status text DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blind_spots_company ON public.blind_spots(company_id);
CREATE INDEX IF NOT EXISTS idx_blind_spots_status ON public.blind_spots(status);

ALTER TABLE public.blind_spots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all blind_spots" ON public.blind_spots;
CREATE POLICY "Admins all blind_spots" ON public.blind_spots FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Users view own blind_spots" ON public.blind_spots;
CREATE POLICY "Users view own blind_spots" ON public.blind_spots FOR SELECT
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users insert own blind_spots" ON public.blind_spots;
CREATE POLICY "Users insert own blind_spots" ON public.blind_spots FOR INSERT
WITH CHECK (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users update own blind_spots" ON public.blind_spots;
CREATE POLICY "Users update own blind_spots" ON public.blind_spots FOR UPDATE
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

-- 2. Opportunities table
CREATE TABLE IF NOT EXISTS public.opportunities (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  pattern_id uuid REFERENCES public.patterns(id) ON DELETE CASCADE,
  opportunity_type text NOT NULL CHECK (opportunity_type IN ('emerging', 'missed')),
  theme text NOT NULL,
  evidence text,
  detected_at timestamptz DEFAULT now(),
  status text DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunities_company ON public.opportunities(company_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON public.opportunities(status);

ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all opportunities" ON public.opportunities;
CREATE POLICY "Admins all opportunities" ON public.opportunities FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Users view own opportunities" ON public.opportunities;
CREATE POLICY "Users view own opportunities" ON public.opportunities FOR SELECT
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users insert own opportunities" ON public.opportunities;
CREATE POLICY "Users insert own opportunities" ON public.opportunities FOR INSERT
WITH CHECK (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users update own opportunities" ON public.opportunities;
CREATE POLICY "Users update own opportunities" ON public.opportunities FOR UPDATE
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));
