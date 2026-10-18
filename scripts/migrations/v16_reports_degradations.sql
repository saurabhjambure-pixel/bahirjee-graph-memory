-- ==========================================
-- BAHIRJEE — REPORTS.DEGRADATIONS
-- ==========================================
-- Ledger of work a run could not complete (time-budget skips, truncated analysis).
-- Empty array = clean run. Non-empty = the brief is partial, and the workspace banners
-- it so a thinner report is never mistaken for a complete one.
-- Run in Supabase SQL Editor. Idempotent.

alter table public.reports
  add column if not exists degradations jsonb default '[]'::jsonb;
