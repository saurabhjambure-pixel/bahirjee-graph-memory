-- ============================================================================
-- v23 — Permit 'parallel_ai' as an observations.source_type
--
-- Deep reads have always been written as source_type 'firecrawl', regardless of which
-- service actually fetched the page. That label has been wrong for some time and is now
-- wrong in a new way:
--
--   * Firecrawl was replaced by Parallel AI Extract as the primary extractor in 8ee3c97
--     (2026-05-12). No code path has called Firecrawl since; api/scrape.js does not read
--     FIRECRAWL_API_KEY at all.
--   * The Parallel AI call was itself malformed from the day it landed — it posted
--     {url, format} to /v1/extract, which rejects both fields (HTTP 422). Every deep read
--     therefore fell through to the Exa fallback.
--
-- Net effect: every row in the database labelled 'firecrawl' was produced by Exa, and the
-- extractor a report was actually built on is not recoverable from the data. With the
-- Parallel AI request fixed, deep reads now come from two genuinely different providers,
-- so the label has to distinguish them or run provenance stays fiction.
--
-- 'firecrawl' is retained, not renamed. ~158 historical rows carry it; rewriting them
-- would assert an origin we cannot actually verify per-row, and dropping the value from
-- the CHECK would invalidate existing data. New writes use the real provider; old rows
-- keep their (inaccurate but honest-about-its-era) label.
--
-- Pairs with OBSERVATION_SOURCE_TYPES in src/services/observationService.js —
-- scripts/observation-source-types.test.mjs fails if the two lists disagree.
--
-- ORDERING: apply this BEFORE deploying the code that emits 'parallel_ai'. A write with a
-- source_type the CHECK rejects fails with SQLSTATE 23514, and storeObservations() counts
-- the error and returns normally — the row is simply lost. That is exactly the silent
-- data-loss shape v22 was written to fix. Migration first, then deploy.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Find the CHECK by definition rather than by name, for the same reason v22 did:
    -- the constraint has been created inline (auto-named), recreated explicitly, and may
    -- have been hand-patched in the SQL editor. Matching on the definition covers all.
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
        'connector',
        -- Page extraction via Parallel AI Extract, the primary deep-read provider (v23)
        'parallel_ai'
    ));
END $$;

-- Note: this does NOT backfill. Rows labelled 'firecrawl' stay as they are — see the
-- header for why re-labelling them would be a guess rather than a correction.
