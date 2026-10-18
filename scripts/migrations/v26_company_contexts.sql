-- ============================================================================
-- v26 — Company contexts (reusable, versioned, per-domain)
--
-- Every run rebuilt the company context from scratch: two advanced Tavily searches,
-- a LinkedIn fetch, a page extract, and a ~40k-token buildContext call that escalates
-- to a stronger model on a thin read. For a company already on file — Paynearby,
-- CareMother — all of that re-derived what we already knew, and threw away whatever
-- the founder had corrected on the context review screen last time.
--
-- Neither existing store could hold the answer:
--   • reports.context is a run OUTPUT — mutated by stepDiscoverCompetitors,
--     stepValidateExa and stepMemory's competitor merge — and stepPersist refuses to
--     write a report without a verification verdict, so there is nowhere to put a
--     context that has been reviewed but not yet run.
--   • startup_contexts has two writers with incompatible row shapes
--     (saveOnboardingInputs writes a shell with only onboarding_inputs, which then
--     reads back as "latest"), holds only the structured layer, and has no domain key.
--
-- So: one current context per (client_id, target_domain), versioned, with provenance.
--
-- DEPENDENCIES: none. This migration is independent of v24 (self-serve + run tier,
-- which the engineering notes notes is written but NOT yet applied) and of v25. It can be applied
-- on its own, in any order relative to those two.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. The table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.company_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- extractTargetDomain() output: lowercased, www-stripped, multi-part suffixes
    -- (.co.uk) resolved. The match key — one client may track several companies.
    target_domain TEXT NOT NULL,
    -- 1-based, per (client_id, target_domain). Assigned by the RPC below, never by
    -- the client, so two concurrent confirms cannot mint the same number.
    version INTEGER NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    -- The full context object the pipeline consumes, minus the run-scoped keys
    -- hydrateStoredContext() strips (_decision, _startupContext, _companyMemory, …).
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- SHA-256 over the sanitized context. Equal hash means "reused, not changed":
    -- the writer stamps last_used_at instead of inserting a version nobody edited.
    -- Same discipline as entity_source_snapshots.content_hash (v20).
    context_hash TEXT,
    -- How this version came to exist. Kept as a CHECK deliberately narrow — see the
    -- v25 lesson below before adding a value.
    source TEXT NOT NULL DEFAULT 'built',
    -- { urls: [], documents: [], linkedin: null, captured_at: iso } — what the
    -- context was built or merged from, so the review screen can say so out loud.
    built_from JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- v25 (tracked_entities.category) was frozen at five values while the code emitted
-- eight; Postgres rejected every row and storeEntityWatchlist counted the error and
-- returned normally, so an uploaded deck contributed nothing for months. If you add a
-- `source:` literal in src/, add it here in the same commit —
-- scripts/context-reuse.test.mjs fails the build if you don't.
ALTER TABLE public.company_contexts DROP CONSTRAINT IF EXISTS company_contexts_source_check;
ALTER TABLE public.company_contexts ADD CONSTRAINT company_contexts_source_check
    CHECK (source IN ('built', 'edited', 'merged', 'rebuilt', 'reused'));

-- ── 2. Indexes ──────────────────────────────────────────────────────────────

-- Exactly one current context per company. This is the constraint that makes
-- "the founder-approved context" a well-defined thing rather than a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_contexts_current
ON public.company_contexts (client_id, target_domain) WHERE is_current;

-- Version history for one company, newest first.
CREATE INDEX IF NOT EXISTS idx_company_contexts_history
ON public.company_contexts (client_id, target_domain, version DESC);

-- ── 3. RLS — mirrors startup_contexts (schema.sql) ──────────────────────────

ALTER TABLE public.company_contexts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage company_contexts" ON public.company_contexts;
CREATE POLICY "Tenant isolated manage company_contexts"
ON public.company_contexts FOR ALL TO authenticated USING (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all company_contexts" ON public.company_contexts;
CREATE POLICY "Admin all company_contexts"
ON public.company_contexts FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ── 4. Atomic version bump ──────────────────────────────────────────────────
--
-- Demoting the current row and inserting the new one must be one statement, or two
-- teammates confirming the same domain at the same moment collide on
-- uq_company_contexts_current and the second confirm throws in the founder's face.
-- Same idiom as increment_run_count (v9) and reserve_report_run.
--
-- SECURITY DEFINER, so the tenant check is enforced here explicitly rather than by
-- RLS: a caller may only write a context for the client they belong to (or as admin).

CREATE OR REPLACE FUNCTION public.set_current_company_context(
    p_client_id     UUID,
    p_target_domain TEXT,
    p_context       JSONB,
    p_context_hash  TEXT,
    p_source        TEXT,
    p_built_from    JSONB
)
RETURNS public.company_contexts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_next    INTEGER;
    v_row     public.company_contexts;
BEGIN
    IF NOT (
        public.is_admin()
        OR p_client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'not authorised to write context for this client';
    END IF;

    -- Unchanged content is a reuse, not a new version: touch and return the current row.
    IF p_context_hash IS NOT NULL THEN
        UPDATE public.company_contexts
        SET last_used_at = NOW()
        WHERE client_id = p_client_id
          AND target_domain = p_target_domain
          AND is_current
          AND context_hash = p_context_hash
        RETURNING * INTO v_row;

        IF FOUND THEN
            RETURN v_row;
        END IF;
    END IF;

    SELECT COALESCE(MAX(version), 0) + 1 INTO v_next
    FROM public.company_contexts
    WHERE client_id = p_client_id AND target_domain = p_target_domain;

    UPDATE public.company_contexts
    SET is_current = FALSE
    WHERE client_id = p_client_id AND target_domain = p_target_domain AND is_current;

    INSERT INTO public.company_contexts (
        client_id, target_domain, version, is_current,
        context, context_hash, source, built_from, created_by, last_used_at
    ) VALUES (
        p_client_id, p_target_domain, v_next, TRUE,
        COALESCE(p_context, '{}'::jsonb), p_context_hash,
        COALESCE(p_source, 'built'), COALESCE(p_built_from, '{}'::jsonb),
        auth.uid(), NOW()
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_current_company_context(UUID, TEXT, JSONB, TEXT, TEXT, JSONB) TO authenticated;
