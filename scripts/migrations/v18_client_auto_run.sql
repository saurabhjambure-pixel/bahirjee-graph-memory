-- ============================================================================
-- v18 — Scheduled recurring intelligence runs
-- ----------------------------------------------------------------------------
-- Adds the opt-in switch that /api/cron-runs reads. A client is NEVER auto-run
-- unless it explicitly carries a cadence: scheduled runs spend real money, so the
-- default must be "off" and the column must be nullable.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- 1. Opt-in cadence. NULL / 'off' = never auto-run (the default for every existing row).
alter table public.clients
  add column if not exists auto_run_cadence text;

alter table public.clients
  drop constraint if exists clients_auto_run_cadence_check;

alter table public.clients
  add constraint clients_auto_run_cadence_check
  check (auto_run_cadence is null or auto_run_cadence in ('off', 'weekly', 'monthly'));

-- 2. When the scheduler last queued a run for this client. Used to decide whether the
--    cadence is due, so a firing that processes only part of the backlog (per-invocation
--    cap) resumes correctly on the next tick instead of always restarting at the same rows.
alter table public.clients
  add column if not exists auto_run_last_queued_at timestamp with time zone;

-- 3. Let a job record that a scheduler created it, rather than mislabelling it as a
--    founder or admin action. Admin views and logs can then tell the two apart.
alter table public.intelligence_jobs
  drop constraint if exists intelligence_jobs_job_origin_check;

alter table public.intelligence_jobs
  add constraint intelligence_jobs_job_origin_check
  check (job_origin in ('founder', 'admin', 'scheduled'));

-- 4. The scheduler scans for due clients on every tick.
create index if not exists idx_clients_auto_run
  on public.clients (auto_run_cadence, auto_run_last_queued_at)
  where auto_run_cadence is not null and auto_run_cadence <> 'off';
