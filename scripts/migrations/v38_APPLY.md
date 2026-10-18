# Applying v38 — target-aware server context write + repair

`v38_service_context_write_targets.sql` runs as a single `BEGIN … COMMIT`, so it either applies
completely or not at all. It needs v30 and v37 already applied. Re-running it is safe because
every repair statement does nothing on data that is already repaired.

## Why it is urgent

From v37 until this migration, each server-side run (worker, cron, admin re-run) wrote its
company context with `target_id = NULL`, and in doing so demoted every current context on the
domain, products included. The current context of a company written that way cannot be read, so
its runs use the last report instead. The header of the SQL file has the details.

Once the matching code is deployed (`saveCompanyContextFromServer` always sends `p_target_id`),
an unmigrated database makes no further server writes, because the old function has no such
argument and PostgREST answers PGRST202. So deploying the code first stops the damage, and
applying v38 repairs it and turns server writes back on.

## Pre-flight

```sql
-- The damage. Expect rows before v38 and none after.
select id, client_id, target_domain, version, is_current, created_at
from public.company_contexts where target_id is null order by target_domain, version;

-- Workspace-named company targets that 3f will rename.
select t.id, t.name, t.target_domain
from public.intelligence_targets t join public.clients cl on cl.id = t.client_id
where t.type = 'company' and t.name = cl.name;
```

Save both results so you can compare them with the post-flight output.

## Apply

Paste the whole file into the Supabase SQL editor and run it once.

## Post-flight. Each query should return 0 rows unless noted.

```sql
-- 1. No context without a target.
select id from public.company_contexts where target_id is null;

-- 2. At most one current context per target.
select target_id, count(*) from public.company_contexts
where is_current group by target_id having count(*) > 1;

-- 3. Every target with context rows has a current one.
select distinct c.target_id from public.company_contexts c
where not exists (select 1 from public.company_contexts x
                  where x.target_id = c.target_id and x.is_current);

-- 4. Every domain with a context has a live company target.
select distinct c.client_id, c.target_domain from public.company_contexts c
where not exists (select 1 from public.intelligence_targets t
                  where t.client_id = c.client_id and t.target_domain = c.target_domain
                    and t.type = 'company' and t.status <> 'archived');

-- 5. The server writer exists with exactly one signature, and that signature takes p_target_id.
--    Expect exactly ONE row, whose arguments end in "p_target_id uuid DEFAULT NULL::uuid".
select pg_get_function_identity_arguments(p.oid) as args
from pg_proc p where p.proname = 'set_current_company_context_service';

-- 6. Browser roles cannot call it. Expect false, false.
select has_function_privilege('authenticated',
         'public.set_current_company_context_service(uuid,text,jsonb,text,text,jsonb,uuid,uuid)', 'execute'),
       has_function_privilege('anon',
         'public.set_current_company_context_service(uuid,text,jsonb,text,text,jsonb,uuid,uuid)', 'execute');
```

If query 1 still returns rows, those rows belong to a domain whose only company target is
archived. Restore the target, or decide by hand which target they belong to.
