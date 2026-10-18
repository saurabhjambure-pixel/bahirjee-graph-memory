-- ============================================================================
-- v38 — The server-side context write learns about targets (and repairs what it broke)
--
-- v37 moved company_contexts' one-current rule from the domain to the target and
-- replaced the BROWSER writer (set_current_company_context) with a target-scoped
-- version. It never touched the SERVER writer, v30's set_current_company_context_service,
-- which stepPersist calls at the end of every worker run. That function still did:
--
--     UPDATE company_contexts SET is_current = FALSE
--     WHERE client_id = p_client_id AND target_domain = p_target_domain AND is_current;
--     INSERT INTO company_contexts (...)            -- target_id never set: NULL
--
-- Since a product carries its parent's target_domain verbatim, that UPDATE demoted the
-- company's current row AND every product's current row on the domain, and the INSERT
-- wrote a row with target_id = NULL. getCurrentCompanyContext filters on the resolved
-- target_id, so the NULL row is invisible to it: every server-written company has been
-- reading NO stored context — falling back to its last report — since v37, and a product
-- run's persist demoted the product's own inherited context. Nothing threw. v37's header
-- says "no code path can write target_id = NULL anymore"; this one did.
--
-- Found live on 2026-10-08: caremother.in, aithonsolutions.com and dhanda.app all had a
-- current row with target_id NULL; dhanda.app (onboarded after v37, server-written only)
-- had no company target at all, so no product could be attached to it.
--
-- Also fixed here: both RPCs' create-on-miss — and v37's backfill — named a new company
-- target after the WORKSPACE (clients.name), so every company a workspace watches showed
-- up as e.g. "Bahirjee". A company target is named after the company.
--
-- Sections:
--   1. set_current_company_context_service — gains p_target_id, resolves exactly as
--      v37's browser RPC does, and is scoped by target everywhere.
--   2. set_current_company_context (browser) — same body as v37, naming fix only.
--   3. Repair: targets for orphaned domains, re-point NULL rows, one current per
--      target, re-promote a demoted product context, rename workspace-named targets.
--
-- DEPENDENCIES: v30 and v37 applied.
-- TRANSACTIONAL, like v37: plain DDL/DML only, so a failure rolls back to nothing.
-- Re-runnable: every repair statement is a no-op on already-repaired data.
-- See v38_APPLY.md for pre- and post-flight checks.
-- ============================================================================

BEGIN;

-- ── 1. Server writer: target-scoped ─────────────────────────────────────────
--
-- The 7-argument v30 signature must be DROPPED, not just shadowed: CREATE OR REPLACE
-- with a different argument list creates a second overload, and PostgREST resolving
-- by argument name could keep hitting the old one (the same hazard v37's header
-- describes for the browser RPC).
DROP FUNCTION IF EXISTS public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID);

CREATE OR REPLACE FUNCTION public.set_current_company_context_service(
    p_client_id     UUID,
    p_target_domain TEXT,
    p_context       JSONB,
    p_context_hash  TEXT,
    p_source        TEXT,
    p_built_from    JSONB,
    p_created_by    UUID DEFAULT NULL,
    -- A product run passes its own target. NULL means "the company target for this
    -- domain", resolved (and created if missing) exactly as the browser RPC does.
    p_target_id     UUID DEFAULT NULL
)
RETURNS public.company_contexts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target_id UUID;
    v_version   INTEGER;
    v_existing  public.company_contexts;
    v_row       public.company_contexts;
BEGIN
    -- No auth.uid() check: access control is the REVOKE block below (service role only),
    -- as in v30. But an explicit target must still belong to the client it is written
    -- for — the caller is trusted, its arguments are not.
    IF p_target_id IS NOT NULL THEN
        SELECT id INTO v_target_id
        FROM public.intelligence_targets
        WHERE id = p_target_id AND client_id = p_client_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'target % does not belong to client %', p_target_id, p_client_id;
        END IF;
    ELSE
        SELECT id INTO v_target_id
        FROM public.intelligence_targets
        WHERE client_id = p_client_id AND target_domain = p_target_domain AND type = 'company'
          AND status <> 'archived'
        LIMIT 1;
    END IF;

    -- Same create-on-miss as v37's browser RPC, and for the same reason: a server-only
    -- company (an admin or cron run, never confirmed in a browser) otherwise never gets a
    -- target, and a context without a target is unreadable.
    IF v_target_id IS NULL THEN
        INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
        VALUES (
            p_client_id, 'company',
            COALESCE(NULLIF(btrim(p_context->>'company_name'), ''), p_target_domain),
            p_target_domain, 'active', p_target_domain
        )
        ON CONFLICT (client_id, target_domain) WHERE type = 'company' AND status <> 'archived'
        DO UPDATE SET updated_at = NOW()
        RETURNING id INTO v_target_id;
    END IF;

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
        COALESCE(p_context, '{}'::jsonb), p_context_hash,
        COALESCE(p_source, 'built'), COALESCE(p_built_from, '{}'::jsonb),
        p_created_by, NOW()
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- The security boundary (see v30's header). Grants are per exact signature, so the
-- dropped 7-argument function's REVOKEs do not carry over — re-state them.
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID, UUID) FROM public;
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID, UUID) TO service_role;

-- ── 2. Browser writer: v37's body, naming fix only ──────────────────────────
--
-- Same signature as v37, so CREATE OR REPLACE replaces it in place and keeps its
-- GRANT to authenticated. The single change is the create-on-miss name.
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

    v_target_id := p_target_id;
    IF v_target_id IS NULL THEN
        SELECT id INTO v_target_id
        FROM public.intelligence_targets
        WHERE client_id = p_client_id AND target_domain = p_target_domain AND type = 'company'
          AND status <> 'archived'
        LIMIT 1;
    END IF;

    IF v_target_id IS NULL THEN
        INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
        VALUES (
            p_client_id, 'company',
            COALESCE(NULLIF(btrim(p_context->>'company_name'), ''), p_target_domain),
            p_target_domain, 'active', p_target_domain
        )
        ON CONFLICT (client_id, target_domain) WHERE type = 'company' AND status <> 'archived'
        DO UPDATE SET updated_at = NOW()
        RETURNING id INTO v_target_id;
    END IF;

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

-- ── 3. Repair ───────────────────────────────────────────────────────────────

-- 3a. A company target for every domain that has contexts or reports but no target.
--     Named after the company, never the workspace.
INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
SELECT DISTINCT ON (c.client_id, c.target_domain)
    c.client_id, 'company',
    COALESCE(NULLIF(btrim(c.context->>'company_name'), ''), c.target_domain),
    c.target_domain, 'active', c.target_domain
FROM public.company_contexts c
WHERE c.target_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.intelligence_targets t
      WHERE t.client_id = c.client_id AND t.target_domain = c.target_domain
        AND t.type = 'company' AND t.status <> 'archived'
  )
ORDER BY c.client_id, c.target_domain, c.created_at DESC
ON CONFLICT DO NOTHING;

INSERT INTO public.intelligence_targets (client_id, type, name, slug, status, target_domain)
SELECT DISTINCT ON (r.client_id, r.target_domain)
    r.client_id, 'company',
    COALESCE(NULLIF(btrim(r.context->>'company_name'), ''), r.target_domain),
    r.target_domain, 'active', r.target_domain
FROM public.reports r
WHERE r.target_domain IS NOT NULL
  AND (r.report_kind IS NULL OR r.report_kind <> 'product')
  AND NOT EXISTS (
      SELECT 1 FROM public.intelligence_targets t
      WHERE t.client_id = r.client_id AND t.target_domain = r.target_domain
        AND t.type = 'company' AND t.status <> 'archived'
  )
ORDER BY r.client_id, r.target_domain, r.created_at DESC
ON CONFLICT DO NOTHING;

-- 3b. Where each NULL-target row belongs. A row carrying a `_product` whose target_id
--     is a real product of this client was written by a product run's persist: it goes
--     back to that product. Everything else is the company's. (Compared as text so a
--     malformed _product.target_id cannot abort the migration with a uuid cast error.)
--
--     Inlined as a CTE in 3c and 3d rather than held in a TEMP ... ON COMMIT DROP table:
--     the Supabase SQL editor commits each statement on its own, which dropped the temp
--     table before 3c could read it ("relation v38_dest does not exist"). Computing it
--     twice is equivalent: 3c changes only is_current, which this mapping never reads.

-- 3c. One current row per target, counting the NULL rows by their destination.
--     Newest wins: a NULL row was always the most recent write for its domain.
--     Demote BEFORE re-pointing, or the re-point trips uq_company_contexts_current_target.
WITH
    v38_dest AS (
        SELECT c.id,
            COALESCE(
                (SELECT p.id FROM public.intelligence_targets p
                 WHERE p.client_id = c.client_id AND p.type = 'product'
                   AND p.id::text = c.context->'_product'->>'target_id'),
                (SELECT t.id FROM public.intelligence_targets t
                 WHERE t.client_id = c.client_id AND t.target_domain = c.target_domain
                   AND t.type = 'company' AND t.status <> 'archived'
                 LIMIT 1)
            ) AS dest
        FROM public.company_contexts c
        WHERE c.target_id IS NULL
    ),
cand AS (
    SELECT c.id, COALESCE(c.target_id, d.dest) AS tgt, c.created_at
    FROM public.company_contexts c
    LEFT JOIN v38_dest d ON d.id = c.id
    WHERE c.is_current
),
ranked AS (
    SELECT id, row_number() OVER (PARTITION BY tgt ORDER BY created_at DESC, id) AS rn
    FROM cand
    WHERE tgt IS NOT NULL
)
UPDATE public.company_contexts c
SET is_current = FALSE
FROM ranked r
WHERE r.id = c.id AND r.rn > 1;

-- 3d. Re-point.
WITH
    v38_dest AS (
        SELECT c.id,
            COALESCE(
                (SELECT p.id FROM public.intelligence_targets p
                 WHERE p.client_id = c.client_id AND p.type = 'product'
                   AND p.id::text = c.context->'_product'->>'target_id'),
                (SELECT t.id FROM public.intelligence_targets t
                 WHERE t.client_id = c.client_id AND t.target_domain = c.target_domain
                   AND t.type = 'company' AND t.status <> 'archived'
                 LIMIT 1)
            ) AS dest
        FROM public.company_contexts c
        WHERE c.target_id IS NULL
    )
UPDATE public.company_contexts c
SET target_id = d.dest
FROM v38_dest d
WHERE d.id = c.id AND d.dest IS NOT NULL;

-- 3e. A target with context rows but none current was demoted by a domain-wide write
--     (typically a product's inherited context, demoted by a company run's persist).
--     Its newest row is its context again.
WITH orphaned AS (
    SELECT DISTINCT ON (c.target_id) c.id
    FROM public.company_contexts c
    WHERE c.target_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.company_contexts x
          WHERE x.target_id = c.target_id AND x.is_current
      )
    ORDER BY c.target_id, c.created_at DESC
)
UPDATE public.company_contexts c
SET is_current = TRUE
FROM orphaned o
WHERE o.id = c.id;

-- 3f. Company targets named after the workspace take the company's own name, from
--     their current context. Left alone when there is no name to give them.
UPDATE public.intelligence_targets t
SET name = btrim(c.context->>'company_name'), updated_at = NOW()
FROM public.clients cl, public.company_contexts c
WHERE t.type = 'company'
  AND cl.id = t.client_id
  AND t.name = cl.name
  AND c.target_id = t.id
  AND c.is_current
  AND NULLIF(btrim(c.context->>'company_name'), '') IS NOT NULL
  AND btrim(c.context->>'company_name') <> t.name;

COMMIT;
