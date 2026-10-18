-- Bahirjee POC — Production Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- All statements are idempotent (safe to re-run).

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 1. REPORTS TABLE — add missing columns and UPDATE policy
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

alter table public.reports add column if not exists memory_state jsonb default '{}'::jsonb;
alter table public.reports add column if not exists card_summary jsonb default '[]'::jsonb;
alter table public.reports add column if not exists run_fingerprint text;
alter table public.reports add column if not exists effective_at timestamp with time zone default timezone('utc'::text, now());
alter table public.reports add column if not exists is_current_snapshot boolean default true;
alter table public.reports add column if not exists superseded_by_report_id uuid references public.reports(id) on delete set null;
alter table public.reports add column if not exists based_on_report_id uuid references public.reports(id) on delete set null;
alter table public.reports add column if not exists target_domain text;
alter table public.reports add column if not exists share_token uuid default gen_random_uuid() unique;

-- Add missing UPDATE policy for client users (they need to update their own reports)
drop policy if exists "clients update own reports" on public.reports;
create policy "clients update own reports" on public.reports for update
using (client_id in (select client_id from public.profiles where id = auth.uid()))
with check (client_id in (select client_id from public.profiles where id = auth.uid()));

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 2. STARTUP CONTEXTS TABLE — verify all columns exist
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

create table if not exists public.startup_contexts (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references public.clients(id) on delete cascade not null,
  version_id text,
  revenue_profile jsonb default '{}'::jsonb,
  market_profile jsonb default '{}'::jsonb,
  dependency_map jsonb default '{}'::jsonb,
  competitive_map jsonb default '{}'::jsonb,
  strategic_assumptions jsonb default '[]'::jsonb,
  exposure_weights jsonb default '{}'::jsonb,
  sensitivity_snapshot jsonb default '{}'::jsonb,
  onboarding_inputs jsonb default '{}'::jsonb,
  auto_inferred jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_startup_contexts_company_created
on public.startup_contexts (company_id, created_at desc);

alter table public.startup_contexts enable row level security;

drop policy if exists "Admins all startup_contexts" on public.startup_contexts;
create policy "Admins all startup_contexts" on public.startup_contexts for all
using (public.is_admin());

drop policy if exists "clients all startup_contexts" on public.startup_contexts;
create policy "clients all startup_contexts" on public.startup_contexts for all
using (company_id in (select client_id from public.profiles where id = auth.uid()))
with check (company_id in (select client_id from public.profiles where id = auth.uid()));

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 3. COMPANY MEMORY STATE TABLE — ensure it exists with all columns
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

create table if not exists public.company_memory_state (
  company_id uuid references public.clients(id) on delete cascade primary key,
  latest_report_id uuid references public.reports(id) on delete set null,
  latest_context_version_id text,
  memory_state jsonb default '{}'::jsonb,
  current_brief jsonb default '{}'::jsonb,
  current_cards jsonb default '[]'::jsonb,
  active_sections jsonb default '[]'::jsonb,
  run_count integer default 0,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.company_memory_state enable row level security;

drop policy if exists "Admins all company_memory_state" on public.company_memory_state;
create policy "Admins all company_memory_state" on public.company_memory_state for all
using (public.is_admin());

drop policy if exists "clients all company_memory_state" on public.company_memory_state;
create policy "clients all company_memory_state" on public.company_memory_state for all
using (company_id in (select client_id from public.profiles where id = auth.uid()))
with check (company_id in (select client_id from public.profiles where id = auth.uid()));

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 4. OBSERVATIONS TABLE — required for v6 pattern engine
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

create table if not exists public.observations (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references public.clients(id) on delete cascade not null,
  run_id text not null,
  theme text not null default 'general',
  raw_text text,
  source_url text,
  source_title text,
  score numeric default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_observations_company_theme
on public.observations (company_id, theme, created_at desc);

create index if not exists idx_observations_company_run
on public.observations (company_id, run_id);

alter table public.observations enable row level security;

drop policy if exists "Admins all observations" on public.observations;
create policy "Admins all observations" on public.observations for all
using (public.is_admin());

drop policy if exists "clients all observations" on public.observations;
create policy "clients all observations" on public.observations for all
using (company_id in (select client_id from public.profiles where id = auth.uid()))
with check (company_id in (select client_id from public.profiles where id = auth.uid()));

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 5. PATTERNS TABLE — required for v6 pattern engine
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

create table if not exists public.patterns (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references public.clients(id) on delete cascade not null,
  theme text not null,
  count integer default 0,
  diversity integer default 0,
  velocity integer default 0,
  maturity text default 'early' check (maturity in ('early', 'forming', 'established', 'dominant')),
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (company_id, theme)
);

create index if not exists idx_patterns_company
on public.patterns (company_id, maturity);

alter table public.patterns enable row level security;

drop policy if exists "Admins all patterns" on public.patterns;
create policy "Admins all patterns" on public.patterns for all
using (public.is_admin());

drop policy if exists "clients all patterns" on public.patterns;
create policy "clients all patterns" on public.patterns for all
using (company_id in (select client_id from public.profiles where id = auth.uid()))
with check (company_id in (select client_id from public.profiles where id = auth.uid()));

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- 6. BLIND SPOTS TABLE — required for BlindSpotEngine
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

create table if not exists public.blind_spots (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references public.clients(id) on delete cascade not null,
  pattern_id uuid references public.patterns(id) on delete cascade,
  theme text not null,
  competitor_entities text[] default '{}',
  status text default 'active' check (status in ('active', 'resolved', 'dismissed')),
  detected_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists idx_blind_spots_company_status
on public.blind_spots (company_id, status);

alter table public.blind_spots enable row level security;

drop policy if exists "Admins all blind_spots" on public.blind_spots;
create policy "Admins all blind_spots" on public.blind_spots for all
using (public.is_admin());

drop policy if exists "clients all blind_spots" on public.blind_spots;
create policy "clients all blind_spots" on public.blind_spots for all
using (company_id in (select client_id from public.profiles where id = auth.uid()))
with check (company_id in (select client_id from public.profiles where id = auth.uid()));
