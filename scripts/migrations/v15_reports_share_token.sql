-- ==========================================
-- BAHIRJEE — REPORTS.SHARE_TOKEN BACKFILL
-- ==========================================
-- Production's `reports` table was created before share_token existed in schema.sql,
-- and `create table if not exists` never alters an existing table — so selecting
-- share_token returned 400 (unknown column) and "Share Brief" failed.
-- Run in Supabase SQL Editor. Idempotent.

alter table public.reports
  add column if not exists share_token uuid default gen_random_uuid();

-- Backfill any rows that predate the column/default.
update public.reports set share_token = gen_random_uuid() where share_token is null;

create unique index if not exists idx_reports_share_token
  on public.reports(share_token);
