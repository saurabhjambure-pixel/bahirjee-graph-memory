-- ============================================================================
-- v22 — Widen observations.source_type for Source Watch and Connectors
--
-- v14 pinned observations.source_type to ('tavily', 'firecrawl', 'exa') — the three
-- retrieval providers that existed then. v20 added Source Watch and the connector
-- steps, both of which write observations with a source_type outside that list:
--
--   src/services/sourceWatch.js  → 'source_watch'
--   lib/handlers/connectors.js   → 'connector'   (seven call sites)
--
-- Every one of those writes was rejected by the CHECK (SQLSTATE 23514). The failure
-- was invisible end to end: storeObservations() counts the error and returns normally,
-- appendObservations() sees no throw, and the stepped pipeline — which reads observations
-- back FROM Postgres rather than from memory — simply found nothing there. Source Watch
-- paid its full scrape latency every run and contributed zero evidence to the report.
--
-- This is the same failure shape v20's own source_class fallback was written to avoid:
-- "a rejected write becomes an empty report rather than a visible error". That fallback
-- only catches PGRST204 (missing column), not a CHECK violation.
--
-- Pairs with the degradation disclosure added to appendObservations() and the guard in
-- scripts/observation-source-types.test.mjs, which fails if code emits a source_type this
-- migration does not permit.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Find the CHECK by definition rather than by name. v6 created it inline (auto-named),
    -- v14 recreated it explicitly, and a database that was hand-patched in the SQL editor
    -- may carry a third name. Matching on the definition covers all three.
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'observations'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source_type%';

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.observations DROP CONSTRAINT %I', constraint_name);
    END IF;

    ALTER TABLE public.observations
    ADD CONSTRAINT observations_source_type_check
    CHECK (source_type IN (
        -- Retrieval providers (v6, v14)
        'tavily', 'firecrawl', 'exa',
        -- Primary Source Watch: the entity's own page changed (v20)
        'source_watch',
        -- Structured sources: tenders, filings, social engagement APIs (v20)
        'connector'
    ));
END $$;

-- Note: this does NOT backfill. Observations rejected before this migration were never
-- written and cannot be recovered — the affected runs are simply thinner than they should
-- have been. Re-running those companies picks the evidence back up.
