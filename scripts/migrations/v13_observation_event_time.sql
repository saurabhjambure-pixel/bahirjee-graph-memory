-- v13: Event time + provider metadata on observations
--
-- Why: observations.timestamp records when WE crawled a source, not when the
-- event happened. Every row in a run shares roughly the same value, so any
-- pattern-velocity metric computed from it measures our own crawl cadence and
-- reads it as market momentum. published_date carries the source's own date.
--
-- published_date is NULLABLE by design: Tavily only reports it on topic:'news',
-- and Exa reports it inconsistently. Consumers must skip NULL rows rather than
-- fall back to `timestamp`.

ALTER TABLE public.observations
    ADD COLUMN IF NOT EXISTS published_date TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS relevance_score REAL NULL,
    ADD COLUMN IF NOT EXISTS title TEXT NULL;

COMMENT ON COLUMN public.observations.published_date IS
    'When the source says the event occurred. NULL when the provider reported no date. Use this for velocity, never `timestamp`.';
COMMENT ON COLUMN public.observations.timestamp IS
    'Ingestion time (when this row was written). NOT event time — see published_date.';
COMMENT ON COLUMN public.observations.relevance_score IS
    'Provider relevance/similarity score, 0..1. Tavily `score` or Exa `score`.';

-- Velocity queries scan a company's dated observations within a window.
CREATE INDEX IF NOT EXISTS idx_observations_company_published
    ON public.observations (company_id, published_date DESC)
    WHERE published_date IS NOT NULL;
