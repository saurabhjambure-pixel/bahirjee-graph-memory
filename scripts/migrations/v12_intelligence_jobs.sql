-- Migration: v12_intelligence_jobs
-- Moves long-running intelligence execution to a durable server-owned job model.

create table if not exists public.intelligence_jobs (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references public.clients(id) on delete cascade not null,
  created_by uuid references auth.users(id) on delete set null not null,
  website_url text not null,
  linkedin_url text,
  job_origin text default 'founder' check (job_origin in ('founder', 'admin')),
  requested_by_role text default 'client_user' check (requested_by_role in ('admin', 'client_user')),
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  current_step text,
  progress_log jsonb default '[]'::jsonb,
  context_payload jsonb,
  uploaded_doc_text text,
  build_context_on_server boolean default false,
  reserved_run boolean default false,
  report_id uuid references public.reports(id) on delete set null,
  error_message text,
  attempt_count integer default 0 not null,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_heartbeat_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_intelligence_jobs_client_created
on public.intelligence_jobs (client_id, created_at desc);

create index if not exists idx_intelligence_jobs_status_created
on public.intelligence_jobs (status, created_at asc);

alter table public.intelligence_jobs enable row level security;

drop policy if exists "Admins all intelligence_jobs" on public.intelligence_jobs;
create policy "Admins all intelligence_jobs" on public.intelligence_jobs for all
using (public.is_admin());

drop policy if exists "clients view intelligence_jobs" on public.intelligence_jobs;
create policy "clients view intelligence_jobs" on public.intelligence_jobs for select
using (
  client_id in (select client_id from public.profiles where id = auth.uid())
);

drop policy if exists "clients insert intelligence_jobs" on public.intelligence_jobs;
create policy "clients insert intelligence_jobs" on public.intelligence_jobs for insert
with check (
  client_id in (select client_id from public.profiles where id = auth.uid()) OR public.is_admin()
);
