-- ============================================================================
-- v21 — Provider status pages as a watched source type
--
-- For a company that ships physical goods, "supply chain" means freight and ports, and
-- that is handled by the conditional `supply` source tier. For a software company the
-- supply chain IS the dependency map: AWS, OpenAI, Stripe, Twilio. Their status pages
-- are the closest thing to a port delay notice — and unlike freight news, an outage at a
-- provider the founder depends on is directly actionable.
--
-- Source Watch already knows how to hash a page and report only what changed. A status
-- page is an unusually good fit: it reads "All Systems Operational" the vast majority of
-- the time, so the hash is stable and a change genuinely means an incident.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- entity_sources.source_type is CHECK-constrained; 'status' has to be added to the list
-- before primarySourceMapper can write one.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'entity_sources'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source_type%';

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.entity_sources DROP CONSTRAINT %I', constraint_name);
    END IF;

    ALTER TABLE public.entity_sources
    ADD CONSTRAINT entity_sources_source_type_check
    CHECK (source_type IN (
        'pricing', 'changelog', 'careers', 'press', 'api_docs',
        'regulatory', 'blog', 'status'
    ));
END $$;
