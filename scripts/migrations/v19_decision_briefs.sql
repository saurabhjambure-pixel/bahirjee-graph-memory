-- Decision Intelligence Briefs
-- Safe to run after the existing v18 migration.

create table if not exists public.decision_briefs (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references public.clients(id) on delete cascade not null,
  created_by uuid references auth.users(id) on delete set null not null,
  raw_input text not null,
  decision_frame jsonb default '{}'::jsonb not null,
  latest_report_id uuid references public.reports(id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.reports add column if not exists report_kind text default 'company';
alter table public.reports add column if not exists decision_id uuid references public.decision_briefs(id) on delete set null;
alter table public.reports add column if not exists decision_context jsonb default '{}'::jsonb;
alter table public.reports add column if not exists decision_brief jsonb default '{}'::jsonb;

alter table public.intelligence_jobs add column if not exists analysis_mode text default 'company';
alter table public.intelligence_jobs add column if not exists decision_id uuid references public.decision_briefs(id) on delete set null;
alter table public.intelligence_jobs add column if not exists decision_context jsonb default '{}'::jsonb;

alter table public.reports drop constraint if exists reports_report_kind_check;
alter table public.reports add constraint reports_report_kind_check check (report_kind in ('company', 'decision'));
alter table public.intelligence_jobs drop constraint if exists intelligence_jobs_analysis_mode_check;
alter table public.intelligence_jobs add constraint intelligence_jobs_analysis_mode_check check (analysis_mode in ('company', 'decision'));

create index if not exists idx_decision_briefs_client_updated on public.decision_briefs (client_id, updated_at desc);
create index if not exists idx_reports_decision_id on public.reports (decision_id, created_at desc);
create index if not exists idx_jobs_decision_id on public.intelligence_jobs (decision_id, created_at desc);

alter table public.decision_briefs enable row level security;
drop policy if exists "Admins all decision_briefs" on public.decision_briefs;
create policy "Admins all decision_briefs" on public.decision_briefs for all
using (public.is_admin()) with check (public.is_admin());
drop policy if exists "clients manage decision_briefs" on public.decision_briefs;
create policy "clients manage decision_briefs" on public.decision_briefs for all
using (client_id in (select client_id from public.profiles where id = auth.uid()))
with check (client_id in (select client_id from public.profiles where id = auth.uid()));

-- The existing report/job client policies continue to scope access. These columns
-- carry metadata only; no raw decision text is copied into search observations.
