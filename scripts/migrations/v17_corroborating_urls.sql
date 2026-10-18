-- ==========================================
-- BAHIRJEE — STRUCTURED_SIGNALS.CORROBORATING_URLS
-- ==========================================
-- Deterministic multi-source corroboration: when dedup merges two signals describing the
-- same event from different outlets, the survivor accumulates the other grounded URLs
-- here (display-only enrichment — single-source signals are not penalized).
-- reports.signals is JSONB and needs no change.
-- Run in Supabase SQL Editor. Idempotent.

alter table public.structured_signals
  add column if not exists corroborating_urls jsonb default '[]'::jsonb;
