# Applying v37 — Intelligence targets

For whoever is running this by hand in the Supabase SQL editor. This migration has never
been applied to any database. Read this whole document before you paste anything in.

## 1. What this does to the database

v37 introduces "intelligence targets" so a workspace can watch a product as its own
research subject, not just the company. It creates three new tables
(`intelligence_targets`, `intelligence_target_sources`, `intelligence_target_relationships`),
adds a `target_id` column to `company_contexts`, `reports` and `intelligence_jobs`, widens
three existing CHECK constraints to allow the new `'product'` / `'inherited'` values, moves
the "one current context" uniqueness rule on `company_contexts` from being scoped by
company domain to being scoped by target, replaces the `set_current_company_context`
database function with a version that takes an extra `target_id` argument, adds row-level
security policies on the three new tables, and — as part of the same run — backfills one
`type='company'` target for every `(client_id, target_domain)` pair that already has a
context or a report on file, then points every existing `company_contexts` row at its new
target. The whole file is wrapped in `BEGIN; … COMMIT;` — see the header comment in the SQL
file itself for why that's safe here and why the function is swapped before the index — so
it either applies completely or not at all.

## 2. Pre-flight — run these BEFORE applying the migration

**2a. Confirm v37 has not already been applied.** Any of these returning rows (rather than
an error) means it's already applied — stop and re-read this document, don't re-run it
blind.

```sql
select 1 from public.intelligence_targets limit 1;
```

Expected: an error — `relation "public.intelligence_targets" does not exist`
(`42P01`/`PGRST205` depending on how you're querying). If you instead get a real result
(including zero rows with no error), the table already exists — stop here.

**2b. Capture the numbers post-flight will be compared against.**

```sql
select count(distinct (client_id, target_domain)) as context_pairs
from public.company_contexts;

select count(distinct (client_id, target_domain)) as report_pairs
from public.reports
where target_domain is not null;
```

Write down both numbers. Call the first `N_CONTEXTS` and the second `N_REPORTS`.

## 3. Run the migration

Open `scripts/migrations/v37_intelligence_targets.sql` in this repo, copy the **entire
file** (it already contains its own `BEGIN;` at the top and `COMMIT;` at the bottom — do
not add your own, and do not split it into pieces), paste it into the Supabase SQL editor,
and run it.

If the editor reports an error partway through: nothing was committed. The whole
transaction rolled back automatically. Fix whatever the error says and re-run the entire
file again from the top — it's idempotent, so re-running after a clean rollback is safe.

## 4. Post-flight verification

Run each of these and compare against the stated expectation.

**4a. The three new tables exist.**

```sql
select id from public.intelligence_targets limit 1;
select id from public.intelligence_target_sources limit 1;
select id from public.intelligence_target_relationships limit 1;
```
Expected: no error (zero or more rows is fine — an error means the table is missing).

**4b. `company_contexts.target_id` exists.**

```sql
select target_id from public.company_contexts limit 1;
```
Expected: no error.

**4c. The backfill count matches pre-flight.**

```sql
select count(*) as company_targets
from public.intelligence_targets
where type = 'company';
```
Expected: equal to `N_CONTEXTS` from step 2b if every domain with a report also had a
context row (the common case); if some `(client_id, target_domain)` pairs exist only in
`reports` and not in `company_contexts`, this number should equal the number of **distinct**
`(client_id, target_domain)` pairs across the union of both — i.e. somewhere between
`max(N_CONTEXTS, N_REPORTS)` and `N_CONTEXTS + N_REPORTS`. If it's outside that range,
something is wrong — do not proceed to treat the backfill as trustworthy.

**4d. No orphaned context rows.**

```sql
select count(*) from public.company_contexts where target_id is null;
```
Expected: `0`.

**4e. Exactly one `is_current` row per `(client_id, target_id)`.**

```sql
select client_id, target_id, count(*)
from public.company_contexts
where is_current
group by client_id, target_id
having count(*) > 1;
```
Expected: zero rows returned. Any row here means the one-current invariant is broken.

**4f. The 6-argument RPC overload is gone; the 7-argument one exists, with `SECURITY DEFINER`.**

```sql
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as args,
  p.prosecdef as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'set_current_company_context';
```
Expected: **exactly one row**. Its `args` should list seven parameters ending in
`p_target_id uuid DEFAULT NULL::uuid` (or similar — the key point is seven parameters, the
last being `p_target_id`), and `is_security_definer` must be `t`. If you see two rows (one
with six args, one with seven), the `DROP FUNCTION` did not run — the migration was not
applied cleanly.

**4g. `GRANT EXECUTE` to `authenticated` is present on the new signature.**

```sql
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'set_current_company_context';
```
Expected: `authenticated_can_execute` is `t` for the (single) row.

## 5. What each failure code means

| Code | Meaning |
|---|---|
| `PGRST205` | PostgREST cannot find the table/view — usually means the table is missing (or PostgREST's schema cache is stale; try reloading it before assuming the migration didn't run). |
| `42P01` | Postgres: "relation does not exist" — the table is missing. |
| `42703` | Postgres: "column does not exist" — a column (e.g. `target_id`) is missing from a table that does exist. |
| `42883` | Postgres: "function does not exist" — `set_current_company_context` (with the argument list you called it with) is missing. If you get this for a 7-argument call after applying v37, the `CREATE OR REPLACE FUNCTION` did not run. |

## 6. Rollback

**Be honest about what this section can and cannot undo.**

### Fully reversible (structure only, no data loss if run immediately after a failed/aborted apply)

If the migration transaction **rolled back on its own** (an error mid-run), there is
nothing to roll back — `BEGIN`/`COMMIT` already discarded everything. Just fix the
underlying issue and re-run the file.

### Reversible, but with a decision to make (a clean apply you want to undo)

If v37 applied successfully and you need to undo it — e.g. to revert to a pre-v37 code
deployment — run the following. This restores the OLD 6-argument RPC and the OLD
domain-scoped unique index, and drops the new tables/columns.

```sql
BEGIN;

-- Restore the old one-current index (domain-scoped), drop the new one.
DROP INDEX IF EXISTS public.uq_company_contexts_current_target;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_contexts_current
    ON public.company_contexts (client_id, target_domain)
    WHERE is_current;
-- ⚠ This CREATE UNIQUE INDEX will FAIL if any company now has two is_current rows for the
same target_domain but different target_id (e.g. a company plus a product context that
both happen to be is_current under the same domain scope, or a company with more than
one row from concurrent activity after v37 went live). Check for that first:
--   select client_id, target_domain, count(*) from public.company_contexts
--   where is_current group by client_id, target_domain having count(*) > 1;
-- If that returns rows, you must resolve them by hand (decide which row should stay
-- is_current) before this index can be created.

-- Restore the old 6-argument RPC, drop the new 7-argument one.
DROP FUNCTION IF EXISTS public.set_current_company_context(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID);
-- Recreate the v26 6-argument definition here — copy its CREATE OR REPLACE FUNCTION body
-- verbatim from scripts/migrations/v26_company_contexts.sql. Not reproduced in this file
-- to avoid two copies drifting apart; go to the source.

-- Drop the new columns.
ALTER TABLE public.company_contexts DROP COLUMN IF EXISTS target_id;
ALTER TABLE public.reports DROP COLUMN IF EXISTS target_id;
ALTER TABLE public.intelligence_jobs DROP COLUMN IF EXISTS target_id;

-- Narrow the CHECKs back (only safe if nothing has written the new literals yet — see below).
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_report_kind_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_report_kind_check
    CHECK (report_kind IN ('company', 'decision'));

ALTER TABLE public.intelligence_jobs DROP CONSTRAINT IF EXISTS intelligence_jobs_analysis_mode_check;
ALTER TABLE public.intelligence_jobs ADD CONSTRAINT intelligence_jobs_analysis_mode_check
    CHECK (analysis_mode IN ('company', 'decision'));

ALTER TABLE public.company_contexts DROP CONSTRAINT IF EXISTS company_contexts_source_check;
ALTER TABLE public.company_contexts ADD CONSTRAINT company_contexts_source_check
    CHECK (source IN ('built', 'edited', 'merged', 'rebuilt', 'reused'));

-- Drop the new tables (cascades their own RLS policies and indexes).
DROP TABLE IF EXISTS public.intelligence_target_relationships;
DROP TABLE IF EXISTS public.intelligence_target_sources;
DROP TABLE IF EXISTS public.intelligence_targets;

COMMIT;
```

### NOT cleanly reversible

- **Narrowing the CHECK constraints back** is only safe if no row has been written with the
  new literals (`'product'` for `report_kind`/`analysis_mode`, `'inherited'` for
  `company_contexts.source`) since v37 went live. If the app has been running against the
  new schema and any product-mode report, job, or inherited context was created, narrowing
  the CHECK will fail (existing rows violate it) or, if you force it by deleting those rows
  first, you **destroy real data** — reports, jobs and contexts a founder saw. There is no
  clean way to "undo" a product-mode report back into a company-mode one; the rollback path
  above assumes you are reverting a deployment that has NOT yet started writing
  product-scoped rows. If it has, decide with the team whether losing that data is
  acceptable before running the narrowing statements.
- **Dropping the new tables** destroys any `intelligence_targets` rows created after the
  migration ran (including ones the RPC's own no-target auto-create branch may have
  inserted for new workspaces), along with their source bundles and relationships. The
  backfilled company targets can be regenerated by re-running section 5 of the migration by
  hand, but anything created by real usage after go-live — product targets a founder
  actually added — cannot be reconstructed from `company_contexts` or `reports` alone.
- **The RLS policies and grants** are cheaply reversible (they're just re-created on the old
  function/tables) and carry no data-loss risk themselves.

If in doubt, do not roll back a live deployment that has already started writing
product-mode data. Escalate instead of guessing.
