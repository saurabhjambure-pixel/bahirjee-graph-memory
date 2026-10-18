-- ============================================================================
-- v36 — A decision you can come back to
--
-- v19 created `decision_briefs` and described it, in its own comment, as holding "durable
-- identities that can be revisited with fresh evidence". It has had no read path since —
-- two writes in reportService and nothing that ever looks at them again. The table stores
-- the FRAME (what was being decided) and nothing about how it was decided or what happened.
--
-- This adds the four things a revisit needs:
--
--   answers          the four facts only the founder could supply — reversibility, worst
--                    case, cost of delay, exclusivity. These SELECT the lens, so a revisit
--                    that cannot see them cannot tell whether the method still fits.
--   framework        which lens was used. Stored rather than re-derived, because re-running
--                    the router months later against a changed frame would silently
--                    reinterpret a decision that was already made.
--   judgment         the decision.v1 brief: criteria, scores, the sensitivity, the
--                    conclusion. This is the artifact a founder defends in a board meeting;
--                    it has to still exist when they are asked about it.
--   chosen_option_id WHAT THE FOUNDER ACTUALLY DID.
--
-- ⚠️ That last one is a product decision, not a data-modelling one. Bahirjee produces a
-- lean — "the evidence favours B" — and the founder is free to choose A. If the Agenda
-- later says "you chose B in March, assuming Y", that sentence must be TRUE, and the only
-- way it can be is if someone recorded the choice rather than the recommendation. Assuming
-- the founder took the lean would make every follow-up a small lie, told months later, at
-- exactly the moment they are relying on it.
--
-- It is nullable on purpose: a decision that was framed and analysed but never made is a
-- real and common state, and pretending otherwise would put a phantom commitment on the
-- Agenda.
--
-- DEPENDENCIES: v19 (the table), v28 (the Agenda these assumptions flow into).
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE public.decision_briefs
    -- { exclusive, reversibility, worst_case, delay_cost } — see decisionFrameworks.js
    ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS framework TEXT,
    -- A decision.v1 brief. Normalised on read as well as write, like brief.v2, because
    -- rows written under an older shape will already exist by the time the shape moves.
    ADD COLUMN IF NOT EXISTS judgment JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The option id from decision_frame.options. Text, not an FK: options live inside a
    -- JSONB frame and are re-derived whenever the frame is re-framed, so a referential
    -- constraint would break on the first edit.
    ADD COLUMN IF NOT EXISTS chosen_option_id TEXT,
    ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
    -- The Agenda is keyed on (client_id, target_domain); a decision's assumptions have to
    -- land on the right company's list when a client tracks more than one.
    ADD COLUMN IF NOT EXISTS target_domain TEXT;

-- Narrow on purpose. See the v25 lesson: a CHECK frozen while the code moved on rejected
-- every row silently for months. If you add a framework id in decisionFrameworks.js, add it
-- here in the SAME commit — scripts/decision-session.test.mjs reads both and fails on drift.
ALTER TABLE public.decision_briefs DROP CONSTRAINT IF EXISTS decision_briefs_framework_check;
ALTER TABLE public.decision_briefs ADD CONSTRAINT decision_briefs_framework_check
    CHECK (framework IS NULL OR framework IN ('mcda', 'wrap', 'regret', 'eisenhower', 'satisficing'));

-- A decision is "made" only when both halves are present. Half a record — a choice with no
-- date, or a date with no choice — would make "you chose this in March" unanswerable in one
-- direction or the other.
ALTER TABLE public.decision_briefs DROP CONSTRAINT IF EXISTS decision_briefs_decided_check;
ALTER TABLE public.decision_briefs ADD CONSTRAINT decision_briefs_decided_check
    CHECK ((chosen_option_id IS NULL) = (decided_at IS NULL));

-- The revisit query: this company's decisions, most recently touched first.
CREATE INDEX IF NOT EXISTS idx_decision_briefs_domain
ON public.decision_briefs (client_id, target_domain, updated_at DESC);

-- Decisions still open — the ones whose assumptions the Agenda is standing watch over.
CREATE INDEX IF NOT EXISTS idx_decision_briefs_undecided
ON public.decision_briefs (client_id, updated_at DESC) WHERE chosen_option_id IS NULL;

-- RLS is unchanged: v19's "clients manage decision_briefs" (FOR ALL, tenant-scoped) and
-- "Admins all decision_briefs" already cover every column added here. Unlike the Agenda,
-- this table is written only from the browser — a decision session is something a founder
-- sits through — so the auth.uid() scoping in those policies is correct rather than a trap.
