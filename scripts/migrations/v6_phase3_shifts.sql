-- ==========================================
-- BAHIRJEE v6.0 — PHASE 3: SHIFTS TABLE
-- ==========================================
-- Run in Supabase SQL Editor AFTER Phase 2 migration.
-- Shifts are rare, threshold-gated detections from patterns.

CREATE TABLE IF NOT EXISTS public.shifts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  pattern_id uuid REFERENCES public.patterns(id) ON DELETE CASCADE NOT NULL,
  shift_type text NOT NULL CHECK (shift_type IN ('emerging', 'structural', 'anomaly')),
  theme text NOT NULL,
  velocity_delta numeric(5,2) DEFAULT 0,
  baseline_velocity numeric(5,2) DEFAULT 0,
  current_velocity numeric(5,2) DEFAULT 0,
  confidence text DEFAULT 'Medium' CHECK (confidence IN ('High', 'Medium', 'Low')),
  status text DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  detected_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shifts_company_id ON public.shifts(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_pattern_id ON public.shifts(pattern_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON public.shifts(status);

-- RLS
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all shifts" ON public.shifts;
CREATE POLICY "Admins all shifts" ON public.shifts FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Users view own shifts" ON public.shifts;
CREATE POLICY "Users view own shifts" ON public.shifts FOR SELECT
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users insert own shifts" ON public.shifts;
CREATE POLICY "Users insert own shifts" ON public.shifts FOR INSERT
WITH CHECK (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Users update own shifts" ON public.shifts;
CREATE POLICY "Users update own shifts" ON public.shifts FOR UPDATE
USING (company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid()));
