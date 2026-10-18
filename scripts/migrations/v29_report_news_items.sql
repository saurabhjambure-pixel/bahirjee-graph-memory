-- ============================================================================
-- v29 — Save the "News that matters" section with the report: reports.news_items
--
-- stepNews scores and ranks news items every run (newsScorer.js), and they were written
-- only to the news_items table — which nothing reads. The report row never carried them,
-- so a news section rendered from the saved report would be empty on every reload and on
-- every shared link. This column is what gives the section something to render.
--
-- Shape: an array of compactNewsItem() objects (src/services/newsScorer.js) —
--   { headline, source, source_url, linked_entity, domain, signal_type,
--     exposure_relevance_score, relevance, jev_relevance?, timestamp }
-- No embedded structured signal: it duplicates `signals` and would bloat every row.
--
-- ORDERING: safe to apply after the code ships. saveReport treats news_items as an
-- optional column — on PGRST204 it drops the column and retries, so a report is never lost
-- to a missing migration; that report simply has no news section. The column is re-probed
-- every five minutes, so applying this heals warm instances without a redeploy. The fix
-- is OFF until this is applied.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL — on purpose. The news_items table has no report_id,
-- so there is no honest way to attach past items to past reports. A '[]' default would make
-- every earlier report read as "nothing moved this run", a conclusion those runs never
-- recorded. NULL means "not recorded" and the section is hidden; saveReport always writes an
-- array, so '[]' on a new row genuinely means the run found nothing to list.
--
-- Read by mapReportRowToAppReport and the shared-link viewer through newsItemsFromRow().
-- Every single-report loader (getReportById, /api/report?token= and ?slug=, get_shared_report())
-- selects `*`; scripts/news-roundtrip.test.mjs fails if one is narrowed without this column.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

alter table public.reports add column if not exists news_items jsonb;

comment on column public.reports.news_items is
  'News that matters: compactNewsItem() objects ranked by stepNews (v28). NULL = not recorded (saved before v28); [] = the run found nothing to list.';
