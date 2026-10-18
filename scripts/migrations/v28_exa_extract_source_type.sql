-- ============================================================================
-- v28 — Give an Exa-fallback deep read a source_type of its own: 'exa_extract'
--
-- 'exa' has meant two different things on observations.source_type:
--
--   * a SEARCH result — searchQuery's fallback when Tavily fails, and funding discovery;
--   * a DEEP READ — fetchPageExtract's fallback when Parallel AI Extract returns too
--     little, served by Exa's contents endpoint.
--
-- The stepped pipeline reads a run's observations back from Postgres and decides what a
-- row is from this column alone (isDeepReadSourceType). 'parallel_ai' and the legacy
-- 'firecrawl' are recognised as deep reads; an Exa-fallback deep read is not, because its
-- label is shared with search rows. So it is compressed to the 1,200-char snippet budget
-- instead of a deep read's 6,000, and it does not replace its own search result in
-- analysis — the full page is fetched, paid for, and mostly thrown away.
--
-- The shared label also collided with the unique index. The write is an upsert on
-- (run_id, source_url, source_type) with ignoreDuplicates. When a run's search had fallen
-- back to Exa AND the deep read of the same URL had too, both rows carried 'exa' and the
-- deep read was silently discarded as a duplicate of its own search result.
--
-- ORDERING: unlike v22 and v23, shipping the code before this migration does NOT lose
-- rows. storeObservations catches the CHECK violation (23514) on an 'exa_extract' row and
-- retries it as 'exa', which is exactly the pre-v27 behaviour, and warns once per process
-- naming this file. Applying the migration is what turns the fix on — nothing else does.
--
-- NO BACKFILL, for v23's reason: relabelling historical 'exa' rows would assert an origin
-- inferred from content rather than recorded at write time. To size how often Parallel AI
-- fell back to Exa before now (read-only — every search-shaped 'exa' row is stored with a
-- 'TITLE:' prefix; an extract is raw page text):
--
--   SELECT count(*) FROM public.observations
--   WHERE source_type = 'exa' AND raw_text NOT LIKE 'TITLE:%';
--
-- Pairs with OBSERVATION_SOURCE_TYPES in src/services/observationService.js —
-- scripts/observation-source-types.test.mjs fails if the two lists disagree.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Found by definition rather than by name, as in v22 and v23: the constraint has been
    -- created inline (auto-named), recreated explicitly, and may have been hand-patched.
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
        'parallel_ai',
        -- Page extraction via Exa, the deep-read fallback (v27)
        'exa_extract'
    ));
END $$;
