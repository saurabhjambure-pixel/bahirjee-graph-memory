-- Bahirjee v6.0: Observations Table
-- Stores ALL Tavily + Firecrawl raw findings for Pattern Engine consumption.
-- Observations are internal — NOT shown to users, NOT implying importance.
-- They persist across runs and feed into the Pattern Engine.

CREATE TABLE IF NOT EXISTS public.observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL,
    run_id UUID NOT NULL,
    theme TEXT NOT NULL DEFAULT 'general',
    entity TEXT,
    source_url TEXT,
    source_type TEXT NOT NULL DEFAULT 'tavily',
    raw_text TEXT,
    title TEXT,
    relevance_score REAL,
    -- When the source says the event happened. NULL when the provider gave no date.
    published_date TIMESTAMPTZ,
    -- Ingestion time (when we crawled it). NOT event time — use published_date for velocity.
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    -- Which temporal window this row was RETRIEVED under (v27_temporal_evidence.sql):
    -- 'current' (6mo, dated events) | 'context' (12mo, explanatory) | 'profile' (unbounded).
    -- Metadata about the request, never a claim about the content — a provider that
    -- ignores a requested window still returns rows, and this is how we notice.
    retrieval_window TEXT,
    -- The start bound actually sent to the provider. NULL when unbounded.
    retrieval_start_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying observations by company within a time window
CREATE INDEX IF NOT EXISTS idx_observations_company_created 
ON public.observations (company_id, created_at DESC);

-- Index for run-based lookups
CREATE INDEX IF NOT EXISTS idx_observations_run_id
ON public.observations (run_id);

-- A search wave can crash after writing some rows and be replayed by the next stepped-worker
-- invocation. This makes the write idempotent (storeObservations upserts on these columns).
-- source_url is nullable and NULLs compare distinct, so URL-less rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_observations_run_url_type
ON public.observations (run_id, source_url, source_type);

-- Enable Row Level Security
ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert and read observations
CREATE POLICY "Authenticated users can insert observations"
ON public.observations FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can read observations"
ON public.observations FOR SELECT
TO authenticated
USING (true);
