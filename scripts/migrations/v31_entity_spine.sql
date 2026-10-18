-- ============================================================================
-- v31 — Entity spine: canonical identity + a lightweight relationship graph
--
-- tracked_entities is keyed on lowercased name today (UNIQUE(company_id, name), from
-- sql/context_signals_schema.sql). "Stripe", "stripe.com" and "Stripe Inc" each open a
-- separate row with its own occurrence_count in brief_cards and its own entity_id in
-- structured_signals — three parallel, non-joining histories for the same competitor.
--
-- This adds:
--
--   1. tracked_entities.canonical_domain + aliases — a resolvable identity, ALONGSIDE
--      (not instead of) the existing name key, using the exact confidence tiers
--      primarySourceMapper.resolveDomain() already computes for entity_sources ('known' /
--      'observed' only — a 'model_claimed' or 'guessed' domain is not trustworthy enough to
--      anchor identity on, even though it is good enough to attempt a fetch). Nullable: a
--      regulator or an "adjacent solution" (a category of approach, not a company —
--      v25_entity_categories.sql) genuinely has no domain, and the unique index below
--      permits any number of NULLs, so this never forces one onto an entity that doesn't
--      have one.
--
--   2. entity_relationships — a graph, in Postgres, not a separate graph database. Every
--      row today reads "this company <relation> this tracked entity" (from_entity_id is
--      always NULL, meaning the company itself) because dependency_map/competitive_map only
--      ever describe the founder's OWN relationship to something, never one tracked entity's
--      relationship to another (e.g. "does Competitor X also depend on AWS" is not a fact
--      this pipeline has yet — it would have to come from a signal). from_entity_id is kept
--      as a real, nullable column anyway so that a genuine entity-to-entity edge is an
--      additive write the day something derives one, not a migration.
--      ⚠️ The uniqueness constraint below covers only the self-anchored case (from_entity_id
--      IS NULL) — see its comment before writing a non-null from_entity_id.
--
--   3. brief_cards.entity_id — a signal's cross-run recurrence (occurrence_count,
--      trend_state) can join the spine by id instead of hashing a normalized string
--      (companyMemoryService.js's buildSignalCardKey). Nullable: a theme-level card (shift,
--      blindspot, opportunity, intro) has no single entity and is not expected to have one.
--
-- 2-3 hop queries over this (e.g. "which tracked entities does this company depend on that
-- are ALSO named as a competitor's dependency, once that fact exists") are one recursive CTE
-- at this scale (tens of entities per company). This table is exactly what would get mirrored
-- into a real graph database if a customer-facing graph feature ever justified one — starting
-- here costs nothing later.
--
-- DEPENDENCIES: sql/context_signals_schema.sql (tracked_entities, brief_cards) and
-- v25_entity_categories.sql (the category CHECK this reads, not writes).
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. canonical identity on tracked_entities ───────────────────────────────

ALTER TABLE public.tracked_entities
    ADD COLUMN IF NOT EXISTS canonical_domain TEXT,
    ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

-- Scoped per company, like every other tracked_entities constraint. Postgres treats every
-- NULL as distinct in a unique index, so this fires only when TWO rows for the SAME company
-- resolve to the SAME real domain — exactly the collision it exists to catch, never on the
-- (common) case of two unrelated entities that both happen to have no known domain.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_entities_company_domain
ON public.tracked_entities (company_id, canonical_domain)
WHERE canonical_domain IS NOT NULL;

-- ── 2. entity_relationships ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.entity_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- NULL = the company itself. See the header — this is the only anchor available today.
    from_entity_id UUID REFERENCES public.tracked_entities(id) ON DELETE CASCADE,
    to_entity_id UUID NOT NULL REFERENCES public.tracked_entities(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (relation IN (
        'competes_with', 'depends_on', 'regulated_by', 'partners_with',
        'integrates_with', 'customer_of', 'invests_in'
    )),
    evidence_url TEXT,
    as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (from_entity_id IS DISTINCT FROM to_entity_id)
);

-- Regenerated deterministically on every run with a structured layer (see
-- entityWatchlistGenerator.generateEntityRelationships + stepPersist) — idempotent by
-- identity via upsert, not append-only, or every run would duplicate the same edge forever.
--
-- ⚠️ Covers only from_entity_id IS NULL (the only case anything writes today — see header).
-- A plain (company_id, to_entity_id, relation) index cannot also dedupe a future non-null
-- from_entity_id edge to the same to_entity_id/relation — widen this to include
-- from_entity_id (with a COALESCE-to-sentinel expression index, since a plain unique index
-- treats every NULL as distinct) in the same change that starts writing one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_relationships_self_edge
ON public.entity_relationships (company_id, to_entity_id, relation)
WHERE from_entity_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_relationships_company
ON public.entity_relationships (company_id, to_entity_id);

ALTER TABLE public.entity_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage entity_relationships" ON public.entity_relationships;
CREATE POLICY "Tenant isolated manage entity_relationships"
ON public.entity_relationships FOR ALL TO authenticated USING (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all entity_relationships" ON public.entity_relationships;
CREATE POLICY "Admin all entity_relationships"
ON public.entity_relationships FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ── 3. brief_cards: link a signal's recurrence to the entity spine ──────────

ALTER TABLE public.brief_cards
    ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES public.tracked_entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_brief_cards_entity
ON public.brief_cards (entity_id) WHERE entity_id IS NOT NULL;
