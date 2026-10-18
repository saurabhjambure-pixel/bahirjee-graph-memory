-- ==========================================
-- BAHIRJEE v8.0 — COMPANY MEMORY LAYER
-- ==========================================
-- Purpose:
-- 1) Keep the user-facing brief "as of now"
-- 2) Persist lineage for cards and signals across runs
-- 3) Reuse prior context and signal memory for the next analysis
--
-- This migration is idempotent and safe to run more than once.

-- ==========================================
-- 1. EXTEND REPORTS AS CURRENT SNAPSHOT LEDGER
-- ==========================================

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS target_domain text,
  ADD COLUMN IF NOT EXISTS memory_state jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS card_summary jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS based_on_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_fingerprint text,
  ADD COLUMN IF NOT EXISTS effective_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  ADD COLUMN IF NOT EXISTS is_current_snapshot boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS superseded_by_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_client_effective_at
  ON public.reports (client_id, effective_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_client_target_domain
  ON public.reports (client_id, target_domain, effective_at DESC);

-- ==========================================
-- 2. COMPANY MEMORY STATE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.company_memory_state (
  company_id uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
  latest_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL,
  latest_context_version_id text,
  memory_state jsonb DEFAULT '{}'::jsonb,
  current_brief jsonb DEFAULT '{}'::jsonb,
  current_cards jsonb DEFAULT '[]'::jsonb,
  active_sections jsonb DEFAULT '[]'::jsonb,
  run_count integer DEFAULT 0,
  updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.company_memory_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all company_memory_state" ON public.company_memory_state;
CREATE POLICY "Admins all company_memory_state"
ON public.company_memory_state
FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Clients all company_memory_state" ON public.company_memory_state;
CREATE POLICY "Clients all company_memory_state"
ON public.company_memory_state
FOR ALL
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
)
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

-- ==========================================
-- 3. BRIEF CARDS
-- ==========================================

CREATE TABLE IF NOT EXISTS public.brief_cards (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  card_key text NOT NULL,
  section_key text NOT NULL,
  card_type text NOT NULL CHECK (card_type IN ('intro', 'signal', 'shift', 'blindspot', 'opportunity', 'memory')),
  title text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  source_index integer,
  source_url text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'resolved')),
  trend_state text DEFAULT 'new' CHECK (trend_state IN ('new', 'recurring', 'strengthening', 'weakened', 'resolved')),
  occurrence_count integer DEFAULT 1,
  first_seen_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL,
  last_seen_report_id uuid REFERENCES public.reports(id) ON DELETE SET NULL,
  first_seen_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  last_seen_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT unique_company_card_key UNIQUE (company_id, card_key)
);

CREATE INDEX IF NOT EXISTS idx_brief_cards_company_status
  ON public.brief_cards (company_id, status);

CREATE INDEX IF NOT EXISTS idx_brief_cards_company_section
  ON public.brief_cards (company_id, section_key);

ALTER TABLE public.brief_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all brief_cards" ON public.brief_cards;
CREATE POLICY "Admins all brief_cards"
ON public.brief_cards
FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Clients all brief_cards" ON public.brief_cards;
CREATE POLICY "Clients all brief_cards"
ON public.brief_cards
FOR ALL
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
)
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

-- ==========================================
-- 4. BRIEF CARD EVIDENCE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.brief_card_evidence (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid REFERENCES public.clients(id) ON DELETE CASCADE NOT NULL,
  card_id uuid REFERENCES public.brief_cards(id) ON DELETE CASCADE NOT NULL,
  report_id uuid REFERENCES public.reports(id) ON DELETE CASCADE,
  signal_index integer,
  source_url text,
  evidence_type text DEFAULT 'signal',
  evidence_excerpt text,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brief_card_evidence_company
  ON public.brief_card_evidence (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_brief_card_evidence_card
  ON public.brief_card_evidence (card_id, created_at DESC);

ALTER TABLE public.brief_card_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins all brief_card_evidence" ON public.brief_card_evidence;
CREATE POLICY "Admins all brief_card_evidence"
ON public.brief_card_evidence
FOR ALL
USING (public.is_admin());

DROP POLICY IF EXISTS "Clients all brief_card_evidence" ON public.brief_card_evidence;
CREATE POLICY "Clients all brief_card_evidence"
ON public.brief_card_evidence
FOR ALL
USING (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
)
WITH CHECK (
  company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

-- ==========================================
-- 5. REPORT RLS POLICIES FOR NEW FIELDS
-- ==========================================
-- Existing report policies remain valid. This section is intentional no-op
-- to make the migration self-documenting for the new snapshot columns.
