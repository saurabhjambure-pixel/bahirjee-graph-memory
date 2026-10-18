-- ============================================================================
-- v37 — Intelligence targets (products as first-class subjects)
--
-- A workspace has always had exactly one subject: the company. Products are the
-- thing founders actually ask about, and there has been nowhere to put one.
--
-- WHY THERE IS NO NEW CONTEXT TABLE. v26 exists because two context stores with
-- incompatible row shapes (startup_contexts) made "the founder-approved context"
-- undefined. Adding intelligence_contexts would repeat that. Instead
-- company_contexts gains target_id and its one-current index widens, so products
-- inherit v26's versioning, hash-idempotency, strip list and RPC unchanged.
--
-- WHY target_domain STAYS. open_questions, reads, daily_checks and both crons are
-- keyed on (client_id, target_domain). A product resolves to its parent company's
-- domain, so every one of them is untouched by this migration. Per-target scoping
-- is a later slice and a deliberate omission here.
--
-- DEPENDENCIES: v26 (company_contexts). Independent of the unapplied v29.
-- Idempotent. Safe to re-run.
--
-- TRANSACTIONAL. This entire file runs inside one BEGIN/COMMIT. Every statement
-- shape it contains — tables, columns, constraints, indexes (created and
-- dropped), the function (created and dropped), grants, row-level security,
-- policies, inserts, updates — is ordinary DDL or DML and runs fine inside a
-- transaction block; none of them is a CONCURRENTLY variant (which Postgres
-- refuses inside BEGIN/COMMIT). So a failure anywhere in this file rolls back to
-- nothing instead of leaving a half-migrated schema, and "just run it again" is
-- always safe.
--
-- ORDERING: the RPC swap (section 6) runs BEFORE the one-current index swap
-- (section 7), even though the index swap reads more naturally as part of the
-- backfill in section 5. Do not "tidy" this back. Reason: the index swap drops
-- the old domain-scoped unique index (uq_company_contexts_current) and replaces
-- it with a target-scoped one (uq_company_contexts_current_target). In the window
-- between that drop and the RPC swap, the OLD 6-argument
-- set_current_company_context still resolves and writes target_id = NULL on every
-- call. Because NULL <> NULL in Postgres, a partial unique index on
-- (client_id, target_id) does not constrain those rows — and the old
-- domain-scoped index protecting them is already gone — so two is_current rows
-- for one company become reachable. Swapping the RPC first (dropping the old
-- 6-arg overload outright) closes that window: by the time the old index is
-- dropped, no code path can write target_id = NULL anymore. Since the whole file
-- is one transaction, this ordering also can't be observed mid-flight by another
-- session — but it still matters for a failure-and-retry: if the file fails
-- after this point in one run, a corrected re-run starts from the same
-- guaranteed-safe order rather than reopening the hazard.
-- ============================================================================

BEGIN;

-- ── 1. Targets ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intelligence_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    -- The compatibility key. A product carries its PARENT's domain, verbatim.
    target_domain TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Narrow on purpose. If you add a literal in targetService.js, add it here in the
-- SAME commit — scripts/targets.test.mjs reads both and fails on drift (v25 lesson).
ALTER TABLE public.intelligence_targets DROP CONSTRAINT IF EXISTS intelligence_targets_type_check;
ALTER TABLE public.intelligence_targets ADD CONSTRAINT intelligence_targets_type_check
    CHECK (type IN ('company', 'product'));

ALTER TABLE public.intelligence_targets DROP CONSTRAINT IF EXISTS intelligence_targets_status_check;
ALTER TABLE public.intelligence_targets ADD CONSTRAINT intelligence_targets_status_check
    CHECK (status IN ('draft', 'active', 'archived'));

-- Exactly one live company target per company. Archived rows are excluded so a
-- company can be archived and re-created without tripping the index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_targets_company
    ON public.intelligence_targets (client_id, target_domain)
    WHERE type = 'company' AND status <> 'archived';

CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_targets_slug
    ON public.intelligence_targets (client_id, slug);

CREATE INDEX IF NOT EXISTS idx_intelligence_targets_client
    ON public.intelligence_targets (client_id, status, updated_at DESC);

-- ── 2. Source bundles ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intelligence_target_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_id UUID NOT NULL REFERENCES public.intelligence_targets(id) ON DELETE CASCADE,
    canonical_url TEXT,
    linkedin_url TEXT,
    supporting_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{ name, uploaded_at, chars }] — the same shape as company_contexts.built_from
    documents JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_target_sources_target
    ON public.intelligence_target_sources (target_id);

-- ── 3. Relationships ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intelligence_target_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_target_id UUID NOT NULL REFERENCES public.intelligence_targets(id) ON DELETE CASCADE,
    child_target_id UUID NOT NULL REFERENCES public.intelligence_targets(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'belongs_to',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT intelligence_target_relationships_no_self CHECK (parent_target_id <> child_target_id)
);

ALTER TABLE public.intelligence_target_relationships
    DROP CONSTRAINT IF EXISTS intelligence_target_relationships_relation_check;
ALTER TABLE public.intelligence_target_relationships
    ADD CONSTRAINT intelligence_target_relationships_relation_check
    CHECK (relation IN ('belongs_to'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_target_relationships
    ON public.intelligence_target_relationships (parent_target_id, child_target_id, relation);

CREATE INDEX IF NOT EXISTS idx_target_relationships_child
    ON public.intelligence_target_relationships (child_target_id);

-- ── 4. Lineage on existing tables ───────────────────────────────────────────

ALTER TABLE public.company_contexts
    ADD COLUMN IF NOT EXISTS target_id UUID REFERENCES public.intelligence_targets(id) ON DELETE CASCADE;

ALTER TABLE public.reports
    ADD COLUMN IF NOT EXISTS target_id UUID REFERENCES public.intelligence_targets(id) ON DELETE SET NULL;

ALTER TABLE public.intelligence_jobs
    ADD COLUMN IF NOT EXISTS target_id UUID REFERENCES public.intelligence_targets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_target ON public.reports (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_target ON public.intelligence_jobs (target_id, created_at DESC);

-- Widened CHECKs. Each literal is added in the same commit as the JS that writes it.
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_report_kind_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_report_kind_check
    CHECK (report_kind IN ('company', 'decision', 'product'));

ALTER TABLE public.intelligence_jobs DROP CONSTRAINT IF EXISTS intelligence_jobs_analysis_mode_check;
ALTER TABLE public.intelligence_jobs ADD CONSTRAINT intelligence_jobs_analysis_mode_check
    CHECK (analysis_mode IN ('company', 'decision', 'product'));

ALTER TABLE public.company_contexts DROP CONSTRAINT IF EXISTS company_contexts_source_check;
ALTER TABLE public.company_contexts ADD CONSTRAINT company_contexts_source_check
    CHECK (source IN ('built', 'edited', 'merged', 'rebuilt', 'reused', 'inherited'));

-- ── 5. Backfill: one company target per company already on file ─────────────

INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
SELECT DISTINCT ON (c.client_id, c.target_domain)
    c.client_id,
    'company',
    COALESCE(cl.name, c.target_domain),
    c.target_domain,
    'active',
    c.target_domain
FROM public.company_contexts c
JOIN public.clients cl ON cl.id = c.client_id
ORDER BY c.client_id, c.target_domain, c.created_at DESC
ON CONFLICT DO NOTHING;

INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
SELECT DISTINCT ON (r.client_id, r.target_domain)
    r.client_id,
    'company',
    COALESCE(cl.name, r.target_domain),
    r.target_domain,
    'active',
    r.target_domain
FROM public.reports r
JOIN public.clients cl ON cl.id = r.client_id
WHERE r.target_domain IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.intelligence_targets t
      WHERE t.client_id = r.client_id AND t.target_domain = r.target_domain AND t.type = 'company'
  )
ORDER BY r.client_id, r.target_domain, r.created_at DESC
ON CONFLICT DO NOTHING;

-- Point every existing context row at its company target.
UPDATE public.company_contexts c
SET target_id = t.id
FROM public.intelligence_targets t
WHERE c.target_id IS NULL
  AND t.client_id = c.client_id
  AND t.target_domain = c.target_domain
  AND t.type = 'company';

-- ── 6. RPC: set_current_company_context now takes a target ──────────────────
--
-- Still authorises via auth.uid(), which is NULL in the worker. companyContextService
-- writes remain BROWSER-ONLY. p_target_id defaults to NULL and is resolved from the
-- domain, so any caller not yet passing it keeps working.
--
-- Runs BEFORE the index swap in section 7 — see the header comment for why: this is
-- what closes the window in which the old 6-arg RPC could write target_id = NULL
-- after the protective domain-scoped index is gone.

-- A function's identity in Postgres is its name PLUS its argument types. v26 defined
-- set_current_company_context with 6 parameters; this version adds a 7th (p_target_id).
-- CREATE OR REPLACE does NOT replace a function with a different argument list — it
-- creates a SECOND overload alongside the old one. A positional 6-argument call would
-- keep resolving to the old function (which never writes target_id, silently), and
-- PostgREST (what supabase.rpc() uses) resolves by argument NAME — with two candidate
-- overloads it can fail with "could not choose the best candidate function", so a
-- context write would silently stop happening. Drop the old signature explicitly first.
-- Idempotent: DROP FUNCTION IF EXISTS is safe to re-run even after the old overload is gone.
DROP FUNCTION IF EXISTS public.set_current_company_context(UUID, TEXT, JSONB, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION public.set_current_company_context(
    p_client_id UUID,
    p_target_domain TEXT,
    p_context JSONB,
    p_context_hash TEXT,
    p_source TEXT,
    p_built_from JSONB,
    p_target_id UUID DEFAULT NULL
) RETURNS public.company_contexts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target_id UUID;
    v_client_name TEXT;
    v_version INTEGER;
    v_existing public.company_contexts;
    v_row public.company_contexts;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND client_id = p_client_id
    ) AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'not authorised for this client';
    END IF;

    -- status <> 'archived' repeats uq_intelligence_targets_company's own partial-index
    -- predicate exactly, so at most one row can ever match here — an archived company
    -- target must never be handed back as "the" target: listTargets hides it and
    -- resolveRunTarget refuses to run it, so a context that attached to it would silently
    -- stop being reusable and the workspace could not run. Because the predicate already
    -- bounds the match to one row, no ORDER BY is needed to make the pick deterministic.
    v_target_id := p_target_id;
    IF v_target_id IS NULL THEN
        SELECT id INTO v_target_id
        FROM public.intelligence_targets
        WHERE client_id = p_client_id AND target_domain = p_target_domain AND type = 'company'
          AND status <> 'archived'
        LIMIT 1;
    END IF;

    -- No target yet does NOT mean "refuse". Two distinct cases land here, and both must
    -- create rather than raise: (1) nothing in the application ever creates a
    -- type='company' target directly — the backfill above only covers a client that
    -- already had a company_contexts row or a report WHEN v37 ran, so any workspace
    -- onboarded afterward hits this on its very first context confirm; (2) the lookup above
    -- deliberately excludes archived rows, so a company whose only target(s) are archived
    -- looks identical to "never had one". Create the company target here instead,
    -- atomically with everything else in this function (SECURITY DEFINER, tenancy already
    -- checked above), so it is impossible to write a context without a live, runnable
    -- target for any caller, present or future.
    IF v_target_id IS NULL THEN
        SELECT name INTO v_client_name FROM public.clients WHERE id = p_client_id;

        INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
        VALUES (p_client_id, 'company', COALESCE(v_client_name, p_target_domain), p_target_domain, 'active', p_target_domain)
        -- uq_intelligence_targets_company is a PARTIAL unique index — (client_id,
        -- target_domain) WHERE type = 'company' AND status <> 'archived'. The ON CONFLICT
        -- target must repeat that predicate exactly, or Postgres cannot infer which index
        -- it names and raises instead of upserting. Two concurrent first-confirms for the
        -- same (client, domain) race this INSERT; the loser takes the DO UPDATE branch and
        -- both end up with the same v_target_id rather than a 23505.
        ON CONFLICT (client_id, target_domain) WHERE type = 'company' AND status <> 'archived'
        DO UPDATE SET updated_at = NOW()
        RETURNING id INTO v_target_id;
    END IF;

    -- Hash-idempotent: an unchanged context stamps last_used_at instead of
    -- minting a version nobody edited.
    SELECT * INTO v_existing
    FROM public.company_contexts
    WHERE client_id = p_client_id AND target_id = v_target_id AND is_current
    LIMIT 1;

    IF v_existing.id IS NOT NULL AND v_existing.context_hash IS NOT DISTINCT FROM p_context_hash THEN
        UPDATE public.company_contexts SET last_used_at = NOW()
        WHERE id = v_existing.id
        RETURNING * INTO v_row;
        RETURN v_row;
    END IF;

    SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.company_contexts
    WHERE client_id = p_client_id AND target_id = v_target_id;

    UPDATE public.company_contexts SET is_current = FALSE
    WHERE client_id = p_client_id AND target_id = v_target_id AND is_current;

    INSERT INTO public.company_contexts (
        client_id, target_domain, target_id, version, is_current,
        context, context_hash, source, built_from, created_by, last_used_at
    ) VALUES (
        p_client_id, p_target_domain, v_target_id, v_version, TRUE,
        p_context, p_context_hash, p_source, p_built_from, auth.uid(), NOW()
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- DROP FUNCTION above discarded v26's GRANT along with the six-argument overload —
-- Postgres ties privileges to a function's exact signature, so a dropped function's
-- grants do not carry over to its replacement. Re-establish it for the new
-- seven-argument signature, matching v26's and v29's grant-to-authenticated idiom.
GRANT EXECUTE ON FUNCTION public.set_current_company_context(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID) TO authenticated;

-- ── 7. One-current index: moves from the domain to the target ───────────────
--
-- Must run AFTER the backfill in section 5 (so no existing row is orphaned by the
-- narrower index) AND after the RPC swap in section 6 (so no code path can still
-- write target_id = NULL by the time the old, domain-scoped protection is gone —
-- see the header comment for the full hazard this ordering closes).

DROP INDEX IF EXISTS public.uq_company_contexts_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_contexts_current_target
    ON public.company_contexts (client_id, target_id)
    WHERE is_current;

-- ── 8. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.intelligence_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligence_target_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligence_target_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage intelligence_targets" ON public.intelligence_targets;
CREATE POLICY "Tenant isolated manage intelligence_targets"
ON public.intelligence_targets FOR ALL TO authenticated USING (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all intelligence_targets" ON public.intelligence_targets;
CREATE POLICY "Admin all intelligence_targets"
ON public.intelligence_targets FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Tenant isolated manage target_sources" ON public.intelligence_target_sources;
CREATE POLICY "Tenant isolated manage target_sources"
ON public.intelligence_target_sources FOR ALL TO authenticated USING (
    target_id IN (
        SELECT id FROM public.intelligence_targets
        WHERE client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
) WITH CHECK (
    target_id IN (
        SELECT id FROM public.intelligence_targets
        WHERE client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
);

DROP POLICY IF EXISTS "Admin all target_sources" ON public.intelligence_target_sources;
CREATE POLICY "Admin all target_sources"
ON public.intelligence_target_sources FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Tenant isolated manage target_relationships" ON public.intelligence_target_relationships;
CREATE POLICY "Tenant isolated manage target_relationships"
ON public.intelligence_target_relationships FOR ALL TO authenticated USING (
    parent_target_id IN (
        SELECT id FROM public.intelligence_targets
        WHERE client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
) WITH CHECK (
    parent_target_id IN (
        SELECT id FROM public.intelligence_targets
        WHERE client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
);

DROP POLICY IF EXISTS "Admin all target_relationships" ON public.intelligence_target_relationships;
CREATE POLICY "Admin all target_relationships"
ON public.intelligence_target_relationships FOR ALL TO authenticated USING (public.is_admin());

COMMIT;
