-- ============================================================================
-- v17 — Make agent_runs' idempotency key addressable by ON CONFLICT
--
-- v16 created the identity index as an EXPRESSION index:
--
--     create unique index uq_agent_runs_identity
--         on public.agent_runs (job_id, agent_id, attempt, coalesce(shard_key, ''));
--
-- The coalesce was deliberate and correct: shard_key is nullable, NULLs compare distinct
-- in Postgres, and without it a replayed unsharded agent run would insert a duplicate row
-- instead of matching the existing one.
--
-- But `beginAgentRun()` upserts with onConflict 'job_id,agent_id,attempt,shard_key' — a
-- plain column list. Postgres cannot infer an expression index from a column list, so every
-- call failed with:
--
--     there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- agentRunStore treats write failures as non-blocking (correctly — telemetry must never
-- fail a run), so this was invisible: beginAgentRun returned null, and because
-- recordArtifact() requires an agent_run_id, artifacts and handoffs silently stopped too.
-- The ENTIRE agent telemetry layer was inert even with v16 applied. Found by the first live
-- replay; no amount of unit testing would have caught it, because none of it touches Postgres.
--
-- Fix: remove the need for coalesce by making shard_key NOT NULL DEFAULT ''. An unsharded
-- run is then the empty string rather than NULL, plain equality works, and a plain-column
-- unique index becomes a valid ON CONFLICT target.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- 1. Existing NULLs become the empty string so the NOT NULL below can be applied.
update public.agent_runs set shard_key = '' where shard_key is null;

alter table public.agent_runs
    alter column shard_key set default '';

alter table public.agent_runs
    alter column shard_key set not null;

-- 2. Replace the expression index with a plain-column one ON CONFLICT can infer.
drop index if exists public.uq_agent_runs_identity;

create unique index if not exists uq_agent_runs_identity
    on public.agent_runs (job_id, agent_id, attempt, shard_key);

comment on index public.uq_agent_runs_identity is
    'Idempotency key for a replayed agent run. Plain columns, not an expression: PostgREST/Postgres cannot infer an expression index from an ON CONFLICT column list. shard_key is NOT NULL DEFAULT '''' so unsharded runs compare by equality rather than being NULL-distinct.';
