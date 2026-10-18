-- ════════════════════════════════════════════════════════════════════════════
-- v27: Temporal evidence provenance
-- ════════════════════════════════════════════════════════════════════════════
--
-- Adds the columns that let the pipeline say WHEN a piece of evidence happened, as
-- distinct from when we fetched it, and what role it may play on a surface.
--
-- Three date fields, and the distinction between them is the whole point:
--
--   event_date      when the thing happened, per the source
--   published_date  when the source reported it
--   retrieved_at    when WE crawled it  — ingestion only, NEVER an event date
--
-- Before this, `structured_signals.timestamp` was set to `new Date()` at transform time
-- and was the only date a news item had. A 2024 article crawled today therefore reached
-- the "News That Matters" surface stamped with today's date. Nothing threw; the brief was
-- simply presenting old material as current.
--
-- ── THIS MIGRATION DESTROYS NOTHING ─────────────────────────────────────────
--
-- Every column is nullable and every CHECK admits NULL, so existing rows stay valid
-- without being touched. There is deliberately no backfill: we cannot reconstruct an
-- event date for a row that never recorded one, and a guessed date is worse than an
-- admitted missing one. Legacy rows read as "temporally unknown", which is true, and the
-- surfaces treat unknown as "not current" rather than inventing a date for it.
--
-- Historical evidence is RETAINED. Temporal role decides where a row may be displayed,
-- never whether it is kept. Nothing here deletes, truncates or rewrites a single row.
--
-- Idempotent: safe to run more than once.
-- Independent of v24/v25/v26; can be applied on its own.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── observations: which window we ASKED under ──────────────────────────────
-- Metadata about the request, not a claim about the content. A provider that ignores a
-- requested date window still returns rows; this is what lets us notice that afterwards
-- instead of assuming the window held.

ALTER TABLE public.observations
    ADD COLUMN IF NOT EXISTS retrieval_window TEXT;

ALTER TABLE public.observations
    ADD COLUMN IF NOT EXISTS retrieval_start_date DATE;

COMMENT ON COLUMN public.observations.retrieval_window IS
    'Which temporal window this row was retrieved under: current (6mo) | context (12mo) | profile (unbounded). NULL on rows written before v27.';
COMMENT ON COLUMN public.observations.retrieval_start_date IS
    'The start bound actually sent to the provider for this row''s query. NULL when unbounded or pre-v27.';

-- ─── structured_signals: when it happened, and what role it may play ────────

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS event_date DATE;

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS published_date TIMESTAMPTZ;

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS temporal_role TEXT;

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS date_confidence TEXT;

ALTER TABLE public.structured_signals
    ADD COLUMN IF NOT EXISTS supporting_evidence JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.structured_signals.event_date IS
    'When the event happened, per the source. NULL when no real date could be established — never inferred from retrieval time.';
COMMENT ON COLUMN public.structured_signals.retrieved_at IS
    'Ingestion time. Kept alongside `timestamp` for clarity; NOT an event date under any circumstance.';
COMMENT ON COLUMN public.structured_signals.temporal_role IS
    'anchor (current, may appear as news) | supporting_context (12mo, explains an anchor) | historical_context (older, retained, linked only). NULL on pre-v27 rows.';
COMMENT ON COLUMN public.structured_signals.supporting_evidence IS
    'Older sources attached to this anchor as labelled context. Additive: linking never removes the linked signal from its own row.';

-- ─── news_items: the current surface ────────────────────────────────────────

ALTER TABLE public.news_items
    ADD COLUMN IF NOT EXISTS event_date DATE;

ALTER TABLE public.news_items
    ADD COLUMN IF NOT EXISTS temporal_role TEXT;

ALTER TABLE public.news_items
    ADD COLUMN IF NOT EXISTS supporting_evidence JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.news_items.event_date IS
    'The anchor event''s date. Distinct from created_at, which is when we wrote the row.';

-- ─── enum guards ────────────────────────────────────────────────────────────
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so each one is guarded by a catalogue
-- lookup. Every CHECK admits NULL explicitly: a legacy row has no temporal provenance and
-- must stay valid. A CHECK that forgot its NULL case would turn an additive migration
-- into one that rejects every pre-existing row on the next write.
--
-- NOT VALID: the constraint applies to new and updated rows without scanning the existing
-- table. That keeps the migration non-blocking on a large observations table AND means it
-- cannot fail on legacy data — which is the behaviour we want, since we are not touching
-- legacy data.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observations_retrieval_window_check') THEN
        ALTER TABLE public.observations
            ADD CONSTRAINT observations_retrieval_window_check
            CHECK (retrieval_window IS NULL OR retrieval_window IN ('current', 'context', 'profile'))
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'structured_signals_temporal_role_check') THEN
        ALTER TABLE public.structured_signals
            ADD CONSTRAINT structured_signals_temporal_role_check
            CHECK (temporal_role IS NULL OR temporal_role IN ('anchor', 'supporting_context', 'historical_context'))
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'structured_signals_date_confidence_check') THEN
        ALTER TABLE public.structured_signals
            ADD CONSTRAINT structured_signals_date_confidence_check
            CHECK (date_confidence IS NULL OR date_confidence IN ('high', 'medium', 'low'))
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_items_temporal_role_check') THEN
        ALTER TABLE public.news_items
            ADD CONSTRAINT news_items_temporal_role_check
            CHECK (temporal_role IS NULL OR temporal_role IN ('anchor', 'supporting_context', 'historical_context'))
            NOT VALID;
    END IF;
END $$;

-- ─── indexes ────────────────────────────────────────────────────────────────
-- The two queries the surfaces actually run: "most recent anchors for this company" and
-- "visible current news for this company".

CREATE INDEX IF NOT EXISTS idx_structured_signals_company_event_date
    ON public.structured_signals (company_id, event_date DESC);

-- structured_signals has no is_visible column — visibility is a news_items concept.
-- Indexing the role alone is what this table's reads actually need.
CREATE INDEX IF NOT EXISTS idx_structured_signals_company_role
    ON public.structured_signals (company_id, temporal_role)
    WHERE temporal_role IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_items_company_event_date
    ON public.news_items (company_id, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_news_items_company_role
    ON public.news_items (company_id, temporal_role, is_visible);

CREATE INDEX IF NOT EXISTS idx_observations_company_retrieval_window
    ON public.observations (company_id, retrieval_window)
    WHERE retrieval_window IS NOT NULL;

-- RLS is untouched. The new columns inherit the existing per-table policies, which key on
-- company_id — unchanged here.
