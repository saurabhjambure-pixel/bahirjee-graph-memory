-- v14: Checkpointed server-side pipeline steps
--
-- Why: runSignalGeneration ran the whole pipeline inside one serverless invocation,
-- hard-capped at 60s on Vercel Hobby. It self-truncated (skipping synthesis, summary,
-- news) rather than failing, and a crash cost the entire run.
--
-- The worker now executes one step per invocation, checkpointing into step_outputs and
-- re-triggering itself. Raw observations deliberately do NOT live in step_outputs — they
-- go to public.observations and are read back by the analyze/v6 steps.

-- 1. Checkpoint envelope. Holds __control (machine step, cursors, retrigger count,
--    circuit-breaker state), __provenance, and each step's distilled output. The existing
--    `current_step` text column stays a human-readable label for the UI; lock and dispatch
--    logic reads __control.step so it never has to parse prose.
ALTER TABLE public.intelligence_jobs
    ADD COLUMN IF NOT EXISTS step_outputs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.intelligence_jobs.step_outputs IS
    'Checkpoint envelope: { __control, __provenance, <step outputs> }. Raw observations are NOT stored here — see public.observations.';

-- 2. `awaiting_context_review` parks a job after the server builds company context, until
--    the founder reviews/edits it and resumes. Nothing may auto-claim a job in this state.
ALTER TABLE public.intelligence_jobs DROP CONSTRAINT IF EXISTS intelligence_jobs_status_check;
ALTER TABLE public.intelligence_jobs
    ADD CONSTRAINT intelligence_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'awaiting_context_review', 'completed', 'failed'));

-- 3. Exa pre-seeded observations were previously mislabelled 'tavily' (source_type was
--    derived solely from the isDeepRead flag).
ALTER TABLE public.observations DROP CONSTRAINT IF EXISTS observations_source_type_check;
ALTER TABLE public.observations
    ADD CONSTRAINT observations_source_type_check
    CHECK (source_type IN ('tavily', 'firecrawl', 'exa'));

-- 4. A search wave can crash after writing some observations and be replayed by the next
--    invocation. Make the write idempotent. Pre-existing duplicates must go first, or the
--    unique index cannot be built. Keep the earliest row of each group.
DELETE FROM public.observations o
USING public.observations dup
WHERE o.run_id = dup.run_id
  AND o.source_url = dup.source_url
  AND o.source_type = dup.source_type
  AND o.source_url IS NOT NULL
  AND o.ctid > dup.ctid;

-- source_url is nullable and NULLs compare distinct, so rows without a URL are exempt from
-- deduplication. Every observation the pipeline writes carries one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_observations_run_url_type
    ON public.observations (run_id, source_url, source_type);
