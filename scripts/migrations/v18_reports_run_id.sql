-- ============================================================================
-- v18 — Make report persistence idempotent on replay
--
-- `saveReport()` was a plain INSERT with no conflict target, so re-running the `persist`
-- step created a SECOND report row. That is reachable in normal operation: stepPersist calls
-- saveReport(), and only afterwards does runOneStep() reach completeIntelligenceJob(). An
-- invocation that dies between those two leaves the report written and the checkpoint still
-- saying `persist` — so the next invocation re-runs the step and inserts again.
--
-- Demonstrated against this database on 2026-08-12 by snapshotting `step_outputs` immediately
-- before the persist invocation, running it, restoring the snapshot, and re-running:
-- one report became two. The founder sees a duplicate in their history, and
-- `intelligence_jobs.report_id` points at only one of them — the other is an orphan.
--
-- Observations already had this property via uq_observations_run_url_type (v14); reports did
-- not. `run_id` is the natural key: it is minted once per run and rehydrated from
-- `__control.run_id` on every resume, so a replayed persist carries the same value.
--
-- A PLAIN unique index is used deliberately, not a partial one. v16 created an expression
-- index for agent_runs and every ON CONFLICT against it failed for months, because Postgres
-- cannot infer an expression (or partial) index from a column list. Existing rows have
-- run_id NULL, and NULLs compare distinct in a plain unique index, so the 39 legacy reports
-- coexist without collision and without needing a backfill.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

alter table public.reports
    add column if not exists run_id uuid;

create unique index if not exists uq_reports_run_id
    on public.reports (run_id);

comment on column public.reports.run_id is
    'Pipeline run that produced this report. Idempotency key for a replayed `persist` step — a crash between saveReport() and completeIntelligenceJob() must not create a second report. NULL on reports written before v18.';
