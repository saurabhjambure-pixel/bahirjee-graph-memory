-- ==========================================
-- BAHIRJEE v6.0 — PHASE 7: IMPACT EVENTS TABLE
-- ==========================================
-- Run in Supabase SQL Editor AFTER Phase 4 migration.
-- Tracks user reactions to intelligence. Silent — no scoring visible to users.

CREATE TABLE IF NOT EXISTS public.impact_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'react_shift', 'follow_up', 'regenerate', 'edit_context',
    'thumbs_up', 'thumbs_down', 'fire', 'insight', 'dismiss'
  )),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_impact_events_company ON public.impact_events(company_id);
CREATE INDEX IF NOT EXISTS idx_impact_events_shift ON public.impact_events(shift_id);
CREATE INDEX IF NOT EXISTS idx_impact_events_type ON public.impact_events(event_type);

ALTER TABLE public.impact_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all impact_events" ON public.impact_events;
CREATE POLICY "Admins all impact_events" ON public.impact_events FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Users insert own impact" ON public.impact_events;
CREATE POLICY "Users insert own impact" ON public.impact_events FOR INSERT
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Users view own impact" ON public.impact_events;
CREATE POLICY "Users view own impact" ON public.impact_events FOR SELECT
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);
