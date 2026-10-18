-- v15: Verifier gates — persist the grounding verdict alongside each report.
--
-- The verifier runs deterministic gates over a report's signals before it is saved
-- (source grounding, duplicate findings, source diversity, date confidence, competitor
-- validation, insight grounding) and records the result here.
--
-- Nullable and additive on purpose: `saveReport` degrades gracefully when this column is
-- absent (same PGRST204 fallback it already uses for target_domain), so the application
-- keeps working whether or not this migration has been applied.
--
-- Shape of the payload:
--   {
--     "policy_version": "v1",
--     "mode": "report" | "enforce",
--     "verdict": "pass" | "downgraded" | "blocked",
--     "checked_at": "<iso8601>",
--     "gates": [ { "id": "...", "status": "pass|warn|fail", "detail": "..." } ],
--     "counts": { "signals_in": 0, "signals_out": 0, "ungrounded": 0, "dropped": 0 },
--     "actions": [ "..." ]
--   }

alter table public.reports
    add column if not exists verification jsonb;

comment on column public.reports.verification is
    'Verifier policy verdict for this report: gate results, counts, and any signals dropped before persistence. Null for reports created before v15 or when the verifier is off.';

-- Surfacing "which reports failed their gates" is the main operational query, and the
-- verdict is low-cardinality, so a partial index on non-null rows keeps it cheap.
create index if not exists idx_reports_verification_verdict
    on public.reports ((verification ->> 'verdict'))
    where verification is not null;

-- No RLS change required: this column rides on public.reports and inherits every policy
-- already enforced there.
