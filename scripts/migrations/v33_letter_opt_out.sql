-- ============================================================================
-- v33 — Letter opt-out
--
-- The Monday Letter is the product's first outbound channel. Anything that writes to
-- a person unprompted needs a way for that person to stop it, and the stop has to be
-- theirs — not a support request.
--
-- ONE COLUMN, deliberately. The obvious companion, `reports.delivered_at`, is absent
-- because it is not needed: completion is now a compare-and-set on
-- intelligence_jobs.status (see completeIntelligenceJob), so exactly one caller wins
-- the transition and only the winner sends. A "have we delivered this?" column would
-- be a second source of truth racing the first, and the two would disagree the first
-- time a send failed after the flag was written.
--
-- DEPENDENCY: lib/_letterDelivery.js reads this column and SURVIVES its absence — an
-- un-migrated database falls back to selecting without it and logs loudly, because
-- here "degraded" means someone who opted out receives a letter. Apply this before
-- enabling LETTER_ENABLED in an environment with real users.
--
-- Independent of v24/v25/v26. Can be applied on its own.
-- ============================================================================

alter table public.profiles
  add column if not exists letter_opt_out boolean not null default false;

comment on column public.profiles.letter_opt_out is
  'Set by the recipient via the unsubscribe link in the Monday Letter. Suppresses outbound letters only; it does not affect access to briefs in the app.';

-- The delivery query filters active members of a client and then drops opt-outs. A
-- partial index matches that shape: only rows that can actually receive a letter are
-- indexed, which is the overwhelming majority and keeps the index small as the opted-out
-- set grows.
create index if not exists idx_profiles_letter_recipients
  on public.profiles (client_id)
  where is_active = true and letter_opt_out = false;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- select count(*) from public.profiles where letter_opt_out = false;
