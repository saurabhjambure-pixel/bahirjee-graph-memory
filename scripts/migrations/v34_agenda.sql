-- ============================================================================
-- v34 — The Agenda: what Bahirjee is currently trying to find out
--
-- Bahirjee has never remembered its own uncertainty. Every run produces
-- `brief.what_could_change_our_view[].watch_for` — concrete, founder-facing
-- observables that would overturn its read, at least two per brief, enforced by a
-- BLOCKING policy gate (briefPolicy B3). Then the run ends and they are discarded.
-- Same for `_startupContext.strategic_assumptions` (verdict recomputed from zero
-- each run, no history), `brief.unknowns`, and the founder's own intake question.
--
-- With nothing carried forward, the only thing a run can do is start over. That is
-- why every run re-derives the same 22 templated queries — they vary only by
-- {year} — and re-pays the LLM for articles it already analysed last Monday
-- (observations dedupe on run_id, so the same URL next week is a brand-new row).
--
-- Three tables:
--   • open_questions — the Agenda. What is still open, what would move it, where
--     to look. The object a daily loop plans against.
--   • reads          — one dated item. The unit that replaces "one big weekly
--     report" as the thing a founder actually receives.
--   • daily_checks   — the proof-of-work ledger. The cadence bar promises "read 19
--     pages this morning, nothing moved"; that sentence must be TRUE.
--     letterService already refuses to claim pages-read because the telemetry did
--     not exist. This is the telemetry.
--
-- KEYED ON (client_id, target_domain), matching company_contexts (v26) — one client
-- may track several companies. Note tracked_entities/entity_sources are keyed on
-- client_id ALONE (its column is misleadingly named company_id but references
-- clients.id), so a multi-company client's watched pages are not domain-separated.
-- Pre-existing; not widened here.
--
-- NO SECURITY DEFINER RPC, deliberately — unlike v26. set_current_company_context
-- authorises via auth.uid(), which is NULL in the worker, which is why
-- companyContextService writes are browser-only. The Agenda must be written by BOTH
-- the browser (founder adds/retires) and the server (a run opens falsifiers, the
-- daily cron stamps a check). So: RLS for the browser, service-role admin client for
-- the server, which bypasses RLS by design. Do not add an auth.uid()-gated RPC here
-- or the daily loop will silently write nothing.
--
-- DEPENDENCIES: clients, auth.users. Independent of v24-v27; applies in any order.
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. open_questions — the Agenda ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.open_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- extractTargetDomain() output, same normalisation as company_contexts.
    target_domain TEXT NOT NULL,

    -- Stable identity for "the same question", derived by normalising the question
    -- text. THIS IS THE ANTI-ROT KEY. tracked_entities is the cautionary tale: it is
    -- append-only, is_active is only ever written TRUE, and no path can retire a row,
    -- so a competitor the founder deleted on the review screen is still being watched
    -- months later. A weekly run regenerates near-identical falsifiers; without a
    -- stable key the Agenda would grow without bound and a question the founder
    -- retired would silently come back. Writers upsert on this key and MUST NOT
    -- resurrect a row whose status is 'retired' (agendaService.openQuestion).
    question_key TEXT NOT NULL,

    -- In the founder's language. Second person, no imperatives — the 18-phrase
    -- advice ban in briefSchema.js applies to every string that reaches a founder.
    question TEXT NOT NULL,
    -- The concrete observable that would move it. Sourced from
    -- what_could_change_our_view[].watch_for, which already has exactly this shape.
    watch_for TEXT,

    -- Where the question came from. Narrow on purpose — see the v25 lesson: that
    -- CHECK was frozen at five values while the code emitted eight, Postgres rejected
    -- every row, and storeEntityWatchlist counted the error and returned normally, so
    -- an uploaded deck contributed nothing to the watchlist for months. If you add an
    -- origin literal in src/, add it here in the SAME commit — scripts/agenda.test.mjs
    -- reads this file and fails the build if the two drift.
    origin TEXT NOT NULL DEFAULT 'falsifier',
    -- report id, decision id, or the assumption statement it came from.
    origin_ref TEXT,

    -- Where to look when this becomes worth spending on. Pages are hash-diffed by
    -- sourceWatch (free); queries cost budget and only run when triage says so.
    watch_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    watch_queries JSONB NOT NULL DEFAULT '[]'::jsonb,

    status TEXT NOT NULL DEFAULT 'open',

    -- Inputs to the priority computation. Priority itself is NOT stored: it is a pure
    -- function of these columns plus staleness (agendaService.computePriority), so it
    -- is testable without a database and cannot go stale relative to its inputs.
    -- sensitivity mirrors strategic_assumptions[].sensitivity.
    sensitivity TEXT,
    -- Feedback tallies. Today the thumbs write impact_events, which become a
    -- {boost, suppress} list injected into a PROMPT as prose, while _signalWeights —
    -- the ten numbers that actually decide what gets searched — are a pure function
    -- of the onboarding form and never move. These two columns are what make founder
    -- feedback change what Bahirjee looks at rather than how it words things.
    useful_count INTEGER NOT NULL DEFAULT 0,
    irrelevant_count INTEGER NOT NULL DEFAULT 0,
    -- The founder's "push this up". Outranks every computed input.
    pinned BOOLEAN NOT NULL DEFAULT FALSE,

    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Last time the daily loop looked at it at all (even to decide it was quiet).
    last_checked_at TIMESTAMPTZ,
    -- Last time evidence actually moved it. Staleness is measured from opened_at or
    -- last_moved_at, never from last_checked_at — otherwise a question that is looked
    -- at daily and never answered would read as permanently fresh.
    last_moved_at TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,

    answer_summary TEXT,
    answered_by_read_id UUID,

    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.open_questions DROP CONSTRAINT IF EXISTS open_questions_origin_check;
ALTER TABLE public.open_questions ADD CONSTRAINT open_questions_origin_check
    CHECK (origin IN ('falsifier', 'assumption', 'unknown', 'founder', 'shift', 'decision'));

ALTER TABLE public.open_questions DROP CONSTRAINT IF EXISTS open_questions_status_check;
ALTER TABLE public.open_questions ADD CONSTRAINT open_questions_status_check
    CHECK (status IN ('open', 'answered', 'retired', 'stale'));

ALTER TABLE public.open_questions DROP CONSTRAINT IF EXISTS open_questions_sensitivity_check;
ALTER TABLE public.open_questions ADD CONSTRAINT open_questions_sensitivity_check
    CHECK (sensitivity IS NULL OR sensitivity IN ('high', 'medium', 'low'));

-- One row per question per company. The upsert target, and the reason a retired
-- question cannot be re-opened by a run that regenerates the same falsifier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_questions_key
ON public.open_questions (client_id, target_domain, question_key);

-- The daily planner's read: open items for one company, least-recently-checked first.
CREATE INDEX IF NOT EXISTS idx_open_questions_due
ON public.open_questions (client_id, target_domain, status, last_checked_at NULLS FIRST);

-- ── 2. reads — one dated item ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    target_domain TEXT NOT NULL,
    -- The Agenda item this Read serves. SET NULL rather than CASCADE: a Read is
    -- evidence that was true when written, and deleting the question it answered must
    -- not delete the answer.
    question_id UUID REFERENCES public.open_questions(id) ON DELETE SET NULL,
    -- The daily mini-run that produced it, for joining back to observations.
    run_id TEXT,

    headline TEXT NOT NULL,
    -- The factual line — what actually moved, attributable to a source.
    what_moved TEXT NOT NULL,
    -- Bahirjee's read. First person here: a Read is Bahirjee talking, like the
    -- letter. Interface chrome stays third person ("Bahirjee last read on Monday").
    what_it_means TEXT,
    -- The honesty line. Uncertainty as presence, not disclaimer — the same discipline
    -- as letterService.confidenceNextStep.
    what_it_does_not_settle TEXT,

    -- Resolved from the observation, NEVER asked of the model: a hallucinated
    -- provenance label is worse than none (internal design log).
    source_class TEXT,
    -- [{ url, host, quote, date, date_confidence }] — a movement whose
    -- date_confidence is 'low' prints no date at all. A gap beats a guess.
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence TEXT,

    -- Set only when this Read cleared the higher bar and was emailed. Most Reads are
    -- in-app only; the weekly Monday Letter is unaffected.
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.reads DROP CONSTRAINT IF EXISTS reads_confidence_check;
ALTER TABLE public.reads ADD CONSTRAINT reads_confidence_check
    CHECK (confidence IS NULL OR confidence IN ('Low', 'Medium', 'High'));

-- The Stream: newest first for one company.
CREATE INDEX IF NOT EXISTS idx_reads_stream
ON public.reads (client_id, target_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reads_question
ON public.reads (question_id) WHERE question_id IS NOT NULL;

-- ── 3. daily_checks — the proof-of-work ledger ──────────────────────────────
--
-- The cadence bar's "read 19 pages this morning, nothing moved" is load-bearing: a
-- quiet app reads as a broken app unless the founder can see it was awake. That
-- sentence must be derived from what actually happened, not asserted.

CREATE TABLE IF NOT EXISTS public.daily_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    target_domain TEXT NOT NULL,
    -- UTC date of the firing. The unique index below makes a re-fired cron a no-op
    -- rather than a double spend — the same compare-and-set discipline as
    -- completeIntelligenceJob's .neq('status','completed').
    checked_on DATE NOT NULL,

    pages_checked INTEGER NOT NULL DEFAULT 0,
    pages_changed INTEGER NOT NULL DEFAULT 0,
    -- Did the ladder climb past Sense? Cheap to record, and the only way to tell a
    -- quiet day from a day the triage call failed.
    triaged BOOLEAN NOT NULL DEFAULT FALSE,
    pursued BOOLEAN NOT NULL DEFAULT FALSE,
    read_id UUID REFERENCES public.reads(id) ON DELETE SET NULL,
    -- Why the ladder stopped where it did, in one plain line. Read by the Desk.
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_checks_day
ON public.daily_checks (client_id, target_domain, checked_on);

CREATE INDEX IF NOT EXISTS idx_daily_checks_recent
ON public.daily_checks (client_id, target_domain, checked_on DESC);

-- ── 4. RLS — mirrors company_contexts (v26) ─────────────────────────────────
--
-- The server writes with the service-role key, which bypasses RLS. These policies
-- govern the browser only: the founder reading their Desk, adding a question,
-- retiring one, or reacting to a Read.

ALTER TABLE public.open_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolated manage open_questions" ON public.open_questions;
CREATE POLICY "Tenant isolated manage open_questions"
ON public.open_questions FOR ALL TO authenticated USING (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
) WITH CHECK (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all open_questions" ON public.open_questions;
CREATE POLICY "Admin all open_questions"
ON public.open_questions FOR ALL TO authenticated USING (public.is_admin());

-- Reads and the check ledger are READ-ONLY to the founder: both are produced by the
-- pipeline, and a founder-editable Read would undermine the evidence trail. Reacting
-- to a Read writes impact_events and open_questions, never reads itself.
DROP POLICY IF EXISTS "Tenant isolated read reads" ON public.reads;
CREATE POLICY "Tenant isolated read reads"
ON public.reads FOR SELECT TO authenticated USING (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all reads" ON public.reads;
CREATE POLICY "Admin all reads"
ON public.reads FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "Tenant isolated read daily_checks" ON public.daily_checks;
CREATE POLICY "Tenant isolated read daily_checks"
ON public.daily_checks FOR SELECT TO authenticated USING (
    client_id IN (SELECT client_id FROM public.profiles WHERE id = auth.uid())
);

DROP POLICY IF EXISTS "Admin all daily_checks" ON public.daily_checks;
CREATE POLICY "Admin all daily_checks"
ON public.daily_checks FOR ALL TO authenticated USING (public.is_admin());
