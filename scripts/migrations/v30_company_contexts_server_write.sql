-- ============================================================================
-- v30 — Server-side write path for company_contexts
--
-- set_current_company_context (v26) authorises through auth.uid(), which is null
-- whenever the Supabase client runs on the service-role key — every server-driven
-- run: the stepped worker (lib/_intelligenceWorker.js), the weekly cron
-- (lib/handlers/cron-runs.js), and an admin re-run with no browser session attached
-- at confirm time. Those runs could READ company_contexts (getCurrentCompanyContext
-- has no auth dependency) but never WRITE it — every improvement such a run made to
-- the context (a competitor confirmed, a funding-stage update folded in) was
-- discarded the moment the invocation ended. "The founder-approved context
-- compounds" only ever compounded through a browser session.
--
-- This adds a SECURITY DEFINER sibling that trusts its p_client_id argument instead
-- of deriving it from auth.uid(). That is safe ONLY because access is restricted to
-- the service role by REVOKE below — the same idiom already used for
-- reserve_report_run (v11_security_hardening.sql): a function with no grant to
-- `public`, `authenticated` or `anon` is unreachable through the PostgREST roles
-- that serve the browser, and reachable only through the service-role connection
-- the worker already holds (src/lib/supabase.js picks the service-role key when
-- `window` is undefined). Do not widen this grant — that would let any signed-in
-- user overwrite any tenant's context.
--
-- The atomic demote-then-insert body is identical to v26's set_current_company_context
-- — same race the comment there describes, same fix, so a concurrent server write and
-- browser confirm still cannot collide on uq_company_contexts_current.
--
-- DEPENDENCIES: v26_company_contexts.sql must be applied first (this function
-- inserts into public.company_contexts).
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_current_company_context_service(
    p_client_id     UUID,
    p_target_domain TEXT,
    p_context       JSONB,
    p_context_hash  TEXT,
    p_source        TEXT,
    p_built_from    JSONB,
    -- Attribution only (no authorisation role): the job's owning user, when the
    -- caller has one (a founder-attributed cron run, an admin re-run). NULL for a
    -- run with no natural owner. Unlike v26's version, never auth.uid() — there is
    -- no session to read it from.
    p_created_by    UUID DEFAULT NULL
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
    -- No tenant check here, unlike v26's function. That function must check because
    -- SECURITY DEFINER bypasses RLS for an ordinary authenticated caller; this
    -- function is not reachable by an ordinary authenticated caller at all — see the
    -- REVOKE block below, which is the actual security boundary.

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
        p_created_by, NOW()
    )
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- Access control IS the security model here — see the header. Revoke from every
-- role a browser session can hold; leave the service role's default privilege
-- untouched (mirrors reserve_report_run, v11_security_hardening.sql).
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID) FROM public;
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID) FROM anon;
