-- ============================================================================
-- v20 — Primary Source Watch
--
-- Bahirjee re-searched the web from scratch on every run. A news article *about*
-- a competitor's price change is weaker evidence than the price change itself, and
-- arrives later. entity_sources has held the pricing/changelog/careers/press URLs for
-- every tracked entity since v7 — nothing ever fetched them (getEntitySources had zero
-- callers). This migration adds the memory that turns those URLs into a monitor:
-- a content hash per fetch, so a run can tell "changed since last time" from "same page".
--
-- Pairs with the weekly cron (v18_client_auto_run.sql). Without runs spread over time
-- there is nothing to diff against, and this table just accumulates baselines.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. Snapshot history ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.entity_source_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_source_id UUID NOT NULL REFERENCES public.entity_sources(id) ON DELETE CASCADE,
    run_id UUID,
    -- SHA-256 of the normalized extract. Comparing hashes rather than text keeps the
    -- change check O(1) and lets us store a trimmed extract instead of a whole page.
    content_hash TEXT NOT NULL,
    -- Trimmed page text, capped by the writer. Kept so a *changed* page can be diffed
    -- against its predecessor without re-fetching the old version.
    extract TEXT,
    fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per distinct content state per source. A run that re-fetches an unchanged
-- page collides here and is ignored, so repeated runs cannot inflate the history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_source_snapshots_content
ON public.entity_source_snapshots (entity_source_id, content_hash);

-- "What did this source look like last time?" — the only read path on the hot loop.
CREATE INDEX IF NOT EXISTS idx_entity_source_snapshots_latest
ON public.entity_source_snapshots (entity_source_id, fetched_at DESC);

ALTER TABLE public.entity_source_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS reaches the tenant through entity_sources → tracked_entities → company_id,
-- mirroring the policy on entity_sources itself.
DROP POLICY IF EXISTS "Tenant isolated manage entity_source_snapshots" ON public.entity_source_snapshots;
CREATE POLICY "Tenant isolated manage entity_source_snapshots"
ON public.entity_source_snapshots FOR ALL TO authenticated USING (
    entity_source_id IN (
        SELECT es.id FROM public.entity_sources es
        JOIN public.tracked_entities te ON te.id = es.entity_id
        WHERE te.company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
) WITH CHECK (
    entity_source_id IN (
        SELECT es.id FROM public.entity_sources es
        JOIN public.tracked_entities te ON te.id = es.entity_id
        WHERE te.company_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
    )
);

DROP POLICY IF EXISTS "Admin all entity_source_snapshots" ON public.entity_source_snapshots;
CREATE POLICY "Admin all entity_source_snapshots"
ON public.entity_source_snapshots FOR ALL TO authenticated USING (
    public.is_admin()
);

-- ── 2. Source provenance on observations ────────────────────────────────────
-- `source_type` already exists and means "which retrieval provider" (tavily/exa).
-- `source_class` answers a different question the founder actually cares about:
-- what KIND of evidence is this? A filing and a blog post are not interchangeable.
-- Nullable with no default: existing rows predate the concept and must not be
-- retroactively labelled as something we did not verify.

ALTER TABLE public.observations
ADD COLUMN IF NOT EXISTS source_class TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'observations_source_class_check'
    ) THEN
        ALTER TABLE public.observations
        ADD CONSTRAINT observations_source_class_check
        CHECK (source_class IS NULL OR source_class IN (
            'primary_company', 'filing', 'tender', 'government', 'review',
            'social', 'research', 'analyst', 'news', 'code'
        ));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_observations_source_class
ON public.observations (company_id, source_class);

-- ── 3. Track when a source was last successfully read ───────────────────────
-- entity_sources.last_checked exists but was never written. The watch step sets it so
-- a source that 404s repeatedly can be retired rather than retried every week.
ALTER TABLE public.entity_sources
ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0;
