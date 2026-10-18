-- ==========================================
-- CONTEXT BUILDING & SIGNALS PREP LAYER
-- Migration: Context, Entities, Signals, News
-- ==========================================

-- ==========================================
-- 1. STARTUP CONTEXTS (Versioned, Immutable)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.startup_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL UNIQUE,
    
    -- Structured from onboarding Block A
    revenue_profile JSONB DEFAULT '{}',
    -- { model, customer_type, sales_motion, geography, funding_stage }
    
    -- Auto-inferred market positioning
    market_profile JSONB DEFAULT '{}',
    -- { industry, category, vertical, target_persona }
    
    -- Extracted dependencies (critical for entity watchlist)
    dependency_map JSONB DEFAULT '{}',
    -- { infra_dependencies[], platform_dependencies[], major_integrations[], regulatory_exposure[], capital_posture }
    
    -- Competitive landscape
    competitive_map JSONB DEFAULT '{}',
    -- { named_competitors[], category_peers[], adjacent_solutions[] }
    
    -- Founder-provided strategic assumptions (Block C)
    strategic_assumptions JSONB DEFAULT '[]',
    -- [{ statement, domain, sensitivity }] max 5
    
    -- Derived exposure weights (0.0 - 1.0 per domain)
    exposure_weights JSONB DEFAULT '{}',
    -- { capital, demand, cost, distribution, regulation, talent }
    
    -- Raw onboarding form data (Block A + B + C)
    onboarding_inputs JSONB DEFAULT '{}',
    
    -- Raw Gemini auto-inferred context (for audit trail)
    auto_inferred JSONB DEFAULT '{}',
    
    -- Sensitivity snapshot from onboarding Block B
    sensitivity_snapshot JSONB DEFAULT '{}',
    -- { infra_cost: Low/Medium/High, revenue_slowdown: Low/Medium/High, hiring_dependency: Low/Medium/High }
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_startup_contexts_company
ON public.startup_contexts (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_startup_contexts_version
ON public.startup_contexts (version_id);

ALTER TABLE public.startup_contexts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage startup_contexts" ON public.startup_contexts;
CREATE POLICY "Tenant isolated manage startup_contexts"
ON public.startup_contexts FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

-- Admin override
DROP POLICY IF EXISTS "Admin all startup_contexts" ON public.startup_contexts;
CREATE POLICY "Admin all startup_contexts"
ON public.startup_contexts FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 2. TRACKED ENTITIES (Entity Watchlist)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.tracked_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    context_version_id TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('infra', 'competitor', 'regulator', 'platform', 'industry_body')),
    metadata JSONB DEFAULT '{}',
    -- { url, why_tracked, source_field }
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_company
ON public.tracked_entities (company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_category
ON public.tracked_entities (company_id, category);

ALTER TABLE public.tracked_entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage tracked_entities" ON public.tracked_entities;
CREATE POLICY "Tenant isolated manage tracked_entities"
ON public.tracked_entities FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all tracked_entities" ON public.tracked_entities;
CREATE POLICY "Admin all tracked_entities"
ON public.tracked_entities FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 2b. COMPANY MEMORY SNAPSHOTS (Current-State Brief)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.company_memory_state (
    company_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
    latest_report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
    latest_context_version_id TEXT,
    memory_state JSONB DEFAULT '{}',
    current_brief JSONB DEFAULT '{}',
    current_cards JSONB DEFAULT '[]',
    active_sections JSONB DEFAULT '[]',
    run_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.company_memory_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage company_memory_state" ON public.company_memory_state;
CREATE POLICY "Tenant isolated manage company_memory_state"
ON public.company_memory_state FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all company_memory_state" ON public.company_memory_state;
CREATE POLICY "Admin all company_memory_state"
ON public.company_memory_state FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 2c. BRIEF CARDS (Lineage for current-state cards)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.brief_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    card_key TEXT NOT NULL,
    section_key TEXT NOT NULL,
    card_type TEXT NOT NULL CHECK (card_type IN ('intro', 'signal', 'shift', 'blindspot', 'opportunity', 'memory')),
    title TEXT NOT NULL,
    payload JSONB DEFAULT '{}',
    source_index INTEGER,
    source_url TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'resolved')),
    trend_state TEXT DEFAULT 'new' CHECK (trend_state IN ('new', 'recurring', 'strengthening', 'weakened', 'resolved')),
    occurrence_count INTEGER DEFAULT 1,
    first_seen_report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
    last_seen_report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, card_key)
);

CREATE INDEX IF NOT EXISTS idx_brief_cards_company_status
ON public.brief_cards (company_id, status);

CREATE INDEX IF NOT EXISTS idx_brief_cards_company_section
ON public.brief_cards (company_id, section_key);

ALTER TABLE public.brief_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage brief_cards" ON public.brief_cards;
CREATE POLICY "Tenant isolated manage brief_cards"
ON public.brief_cards FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all brief_cards" ON public.brief_cards;
CREATE POLICY "Admin all brief_cards"
ON public.brief_cards FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 2d. BRIEF CARD EVIDENCE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.brief_card_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    card_id UUID NOT NULL REFERENCES public.brief_cards(id) ON DELETE CASCADE,
    report_id UUID REFERENCES public.reports(id) ON DELETE CASCADE,
    signal_index INTEGER,
    source_url TEXT,
    evidence_type TEXT DEFAULT 'signal',
    evidence_excerpt TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brief_card_evidence_company
ON public.brief_card_evidence (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_brief_card_evidence_card
ON public.brief_card_evidence (card_id, created_at DESC);

ALTER TABLE public.brief_card_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage brief_card_evidence" ON public.brief_card_evidence;
CREATE POLICY "Tenant isolated manage brief_card_evidence"
ON public.brief_card_evidence FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all brief_card_evidence" ON public.brief_card_evidence;
CREATE POLICY "Admin all brief_card_evidence"
ON public.brief_card_evidence FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 3. ENTITY SOURCES (Primary Tracking Targets)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.entity_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES public.tracked_entities(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('pricing', 'changelog', 'careers', 'press', 'api_docs', 'regulatory', 'blog')),
    url TEXT NOT NULL,
    last_checked TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_sources_entity
ON public.entity_sources (entity_id, is_active);

ALTER TABLE public.entity_sources ENABLE ROW LEVEL SECURITY;

-- RLS via parent entity's company_id
DROP POLICY IF EXISTS "Tenant isolated manage entity_sources" ON public.entity_sources;
CREATE POLICY "Tenant isolated manage entity_sources"
ON public.entity_sources FOR ALL TO authenticated USING (
    entity_id IN (
        SELECT id FROM public.tracked_entities
        WHERE company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
) WITH CHECK (
    entity_id IN (
        SELECT id FROM public.tracked_entities
        WHERE company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
);

DROP POLICY IF EXISTS "Admin all entity_sources" ON public.entity_sources;
CREATE POLICY "Admin all entity_sources"
ON public.entity_sources FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 4. STRUCTURED SIGNALS (Deterministic Signal Objects)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.structured_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    run_id UUID,
    entity_id UUID REFERENCES public.tracked_entities(id) ON DELETE SET NULL,
    entity_name TEXT,
    event_type TEXT NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN ('demand', 'cost', 'capital', 'distribution', 'regulation', 'talent')),
    magnitude_score NUMERIC(4,2) DEFAULT 0,
    replication_flag BOOLEAN DEFAULT false,
    source_type TEXT NOT NULL CHECK (source_type IN ('primary', 'secondary')),
    source_url TEXT,
    raw_observation_id UUID REFERENCES public.observations(id) ON DELETE SET NULL,
    raw_headline TEXT,
    raw_details TEXT,
    -- ── temporal provenance (v27_temporal_evidence.sql) ─────────────────────
    -- Three dates, and the distinction between them is the point:
    --   event_date      when it happened, per the source
    --   published_date  when the source reported it
    --   retrieved_at    when WE crawled it — ingestion only, NEVER an event date
    -- `timestamp` below predates these and is ingestion time; it is kept for
    -- compatibility and must not be read as an event date.
    event_date DATE,
    published_date TIMESTAMPTZ,
    retrieved_at TIMESTAMPTZ,
    -- anchor (current, may appear as news) | supporting_context | historical_context
    temporal_role TEXT CHECK (temporal_role IS NULL OR temporal_role IN ('anchor', 'supporting_context', 'historical_context')),
    date_confidence TEXT CHECK (date_confidence IS NULL OR date_confidence IN ('high', 'medium', 'low')),
    -- Older sources attached to this anchor as labelled context. Additive: linking a
    -- signal here never removes it from its own row.
    supporting_evidence JSONB DEFAULT '[]'::jsonb,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_structured_signals_company_run
ON public.structured_signals (company_id, run_id);

CREATE INDEX IF NOT EXISTS idx_structured_signals_domain
ON public.structured_signals (company_id, domain);

CREATE INDEX IF NOT EXISTS idx_structured_signals_entity
ON public.structured_signals (entity_id);

ALTER TABLE public.structured_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage structured_signals" ON public.structured_signals;
CREATE POLICY "Tenant isolated manage structured_signals"
ON public.structured_signals FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all structured_signals" ON public.structured_signals;
CREATE POLICY "Admin all structured_signals"
ON public.structured_signals FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ==========================================
-- 5. NEWS ITEMS (Curated Display Layer)
-- ==========================================

CREATE TABLE IF NOT EXISTS public.news_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    signal_id UUID REFERENCES public.structured_signals(id) ON DELETE SET NULL,
    headline TEXT NOT NULL,
    source TEXT,
    source_url TEXT,
    linked_entity TEXT,
    domain TEXT,
    signal_type TEXT,
    -- Composite exposure score
    exposure_relevance_score NUMERIC(6,4) DEFAULT 0,
    -- Strict 3-line summary
    line_1_fact TEXT NOT NULL,
    line_2_economic TEXT NOT NULL,
    line_3_startup TEXT NOT NULL,
    -- Decay management
    decay_factor NUMERIC(4,3) DEFAULT 1.000,
    last_reinforced_at TIMESTAMPTZ DEFAULT NOW(),
    -- Display threshold: only show if score * decay >= 0.15
    is_visible BOOLEAN DEFAULT true,
    -- ── temporal provenance (v27_temporal_evidence.sql) ─────────────────────
    -- The anchor event's own date, distinct from created_at (when we wrote the row).
    -- Only an 'anchor' may reach this surface: a news item IS a current event, and a
    -- row whose date came from its crawl time is not one.
    event_date DATE,
    temporal_role TEXT CHECK (temporal_role IS NULL OR temporal_role IN ('anchor', 'supporting_context', 'historical_context')),
    -- Older sources shown behind this item as labelled context, never as news.
    supporting_evidence JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_items_company_visible
ON public.news_items (company_id, is_visible, exposure_relevance_score DESC);

CREATE INDEX IF NOT EXISTS idx_news_items_decay
ON public.news_items (company_id, last_reinforced_at);

ALTER TABLE public.news_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage news_items" ON public.news_items;
CREATE POLICY "Tenant isolated manage news_items"
ON public.news_items FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all news_items" ON public.news_items;
CREATE POLICY "Admin all news_items"
ON public.news_items FOR ALL TO authenticated USING (
    public.is_admin()
);
