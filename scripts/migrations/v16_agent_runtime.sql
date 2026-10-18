-- v16: Agent runtime tables.
--
-- Normalized execution history for the agent overlay. `intelligence_jobs.step_outputs`
-- stays the live checkpoint (compact, rewritten every invocation); these tables are the
-- durable record of what each agent did, emitted, and handed off.
--
-- Split rationale: the checkpoint must stay small because it is rewritten on every
-- serverless invocation, so anything append-only or historical belongs here instead.
--
-- RLS: none of these tables carry client_id, so read scoping joins through
-- intelligence_jobs. There are deliberately NO client INSERT/UPDATE policies — only the
-- worker writes, and it uses the service role, which bypasses RLS.

-- ─── agent_runs ───────────────────────────────────────────────────────────
-- One row per (job, agent, attempt, shard). The unit of retry and replay.

create table if not exists public.agent_runs (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.intelligence_jobs(id) on delete cascade,
    parent_agent_run_id uuid references public.agent_runs(id) on delete set null,
    agent_id text not null,
    agent_version text not null default 'v1',
    status text not null default 'running'
        check (status in ('running', 'completed', 'failed', 'deferred', 'skipped', 'quarantined')),
    attempt integer not null default 1,
    shard_key text,
    steps_completed text[] not null default '{}',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    lease_expires_at timestamptz,
    confidence real,
    provider_cost_usd numeric(12, 6),
    token_usage integer,
    failure_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Idempotency key from the plan: job_id + agent_id + attempt (+ shard). shard_key is
-- nullable and NULLs compare distinct in Postgres, so coalesce it or replayed unsharded
-- runs would silently insert duplicates instead of upserting.
create unique index if not exists uq_agent_runs_identity
    on public.agent_runs (job_id, agent_id, attempt, coalesce(shard_key, ''));

create index if not exists idx_agent_runs_job on public.agent_runs (job_id, started_at);
create index if not exists idx_agent_runs_status on public.agent_runs (status, started_at desc)
    where status in ('running', 'failed', 'quarantined');

-- ─── agent_artifacts ──────────────────────────────────────────────────────
-- Append-only outputs. Never updated in place: mutating a prior artifact breaks replay
-- determinism and makes evaluations unreliable.

create table if not exists public.agent_artifacts (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.intelligence_jobs(id) on delete cascade,
    agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
    artifact_type text not null,
    artifact_version text not null default 'v1',
    payload jsonb not null default '{}'::jsonb,
    source_count integer not null default 0,
    evidence_refs jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_agent_artifacts_job on public.agent_artifacts (job_id, created_at);
create index if not exists idx_agent_artifacts_run on public.agent_artifacts (agent_run_id);
create index if not exists idx_agent_artifacts_type on public.agent_artifacts (artifact_type, created_at desc);

comment on column public.agent_artifacts.payload is
    'Summary or references only. Bulk evidence lives in public.observations — duplicating it here would defeat the point of keeping the checkpoint small.';

-- ─── agent_handoffs ───────────────────────────────────────────────────────
-- Explicit transitions. Makes the graph auditable after the fact.

create table if not exists public.agent_handoffs (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.intelligence_jobs(id) on delete cascade,
    from_agent_run_id uuid references public.agent_runs(id) on delete set null,
    to_agent_id text not null,
    handoff_reason text,
    decision_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_agent_handoffs_job on public.agent_handoffs (job_id, created_at);

-- ─── agent_evaluations ────────────────────────────────────────────────────
-- Populated by the evaluation harness. Created now so scoring can be backfilled against
-- runs that already happened.

create table if not exists public.agent_evaluations (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.intelligence_jobs(id) on delete cascade,
    agent_run_id uuid references public.agent_runs(id) on delete cascade,
    policy_version text not null,
    scorecard jsonb not null default '{}'::jsonb,
    passed boolean,
    created_at timestamptz not null default now()
);

create index if not exists idx_agent_evaluations_job on public.agent_evaluations (job_id, created_at);
create index if not exists idx_agent_evaluations_passed on public.agent_evaluations (passed, created_at desc);

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Every table gets RLS. Clients may READ rows belonging to their own jobs; nobody but the
-- service role may write.

alter table public.agent_runs enable row level security;
alter table public.agent_artifacts enable row level security;
alter table public.agent_handoffs enable row level security;
alter table public.agent_evaluations enable row level security;

drop policy if exists "Admins all agent_runs" on public.agent_runs;
create policy "Admins all agent_runs" on public.agent_runs for all
using (public.is_admin());

drop policy if exists "clients view agent_runs" on public.agent_runs;
create policy "clients view agent_runs" on public.agent_runs for select
using (
  job_id in (
    select id from public.intelligence_jobs
    where client_id in (select client_id from public.profiles where id = auth.uid())
  )
);

drop policy if exists "Admins all agent_artifacts" on public.agent_artifacts;
create policy "Admins all agent_artifacts" on public.agent_artifacts for all
using (public.is_admin());

drop policy if exists "clients view agent_artifacts" on public.agent_artifacts;
create policy "clients view agent_artifacts" on public.agent_artifacts for select
using (
  job_id in (
    select id from public.intelligence_jobs
    where client_id in (select client_id from public.profiles where id = auth.uid())
  )
);

drop policy if exists "Admins all agent_handoffs" on public.agent_handoffs;
create policy "Admins all agent_handoffs" on public.agent_handoffs for all
using (public.is_admin());

drop policy if exists "clients view agent_handoffs" on public.agent_handoffs;
create policy "clients view agent_handoffs" on public.agent_handoffs for select
using (
  job_id in (
    select id from public.intelligence_jobs
    where client_id in (select client_id from public.profiles where id = auth.uid())
  )
);

-- Evaluations are internal quality data: admin-only, no client read policy.
drop policy if exists "Admins all agent_evaluations" on public.agent_evaluations;
create policy "Admins all agent_evaluations" on public.agent_evaluations for all
using (public.is_admin());
