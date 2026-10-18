-- v25_entity_categories.sql
--
-- Widen tracked_entities.category to match what the code actually emits.
--
-- The CHECK has been frozen at the original five categories since
-- sql/context_signals_schema.sql, but entityWatchlistGenerator has been emitting
-- 'customer', 'investor' and 'partner' ever since document intel landed — the entities
-- its own comment calls "the highest-signal entities we get", because a public site
-- rarely names its customers or investors. Postgres rejected every one of those rows,
-- storeEntityWatchlist counted the error and returned normally, and the founder's
-- uploaded deck contributed nothing to the watchlist.
--
-- This is the same drift that v22/v23 fixed for observations.source_type. The lesson is
-- recorded in observationService.js: a CHECK constraint and the constant that feeds it
-- must be widened in the same change that starts emitting the new value.
--
-- 'adjacent' is new here. Adjacent solutions are approaches ("Traditional 3PL
-- Providers"), not companies, and were previously stored as 'competitor' — which made
-- them eligible for domain guessing in primarySourceMapper and counted them against the
-- verifier's competitor-validation gate. They are worth tracking and are not competitors.

ALTER TABLE public.tracked_entities
    DROP CONSTRAINT IF EXISTS tracked_entities_category_check;

ALTER TABLE public.tracked_entities
    ADD CONSTRAINT tracked_entities_category_check
    CHECK (category IN (
        'infra',
        'competitor',
        'regulator',
        'platform',
        'industry_body',
        'customer',
        'investor',
        'partner',
        'adjacent'
    ));

-- Reclassify rows written before this migration. Adjacent solutions were stored as
-- competitors and are identifiable by the source_field the generator stamps on them.
UPDATE public.tracked_entities
SET category = 'adjacent'
WHERE category = 'competitor'
  AND metadata->>'source_field' = 'adjacent_solutions';
