-- ============================================================================
-- Fix: profiles pointing at a client that no longer exists
-- ----------------------------------------------------------------------------
-- Symptom: running an analysis fails with
--   insert or update on table "intelligence_jobs" violates foreign key constraint
--   "intelligence_jobs_client_id_fkey"
-- Cause: a profile's client_id references a clients row that doesn't exist. This is
--   possible when the deployed profiles table predates the client_id FK (so it was
--   never enforced).
-- ============================================================================

-- 1. DIAGNOSE — list profiles whose client_id has no matching client.
select p.id, u.email, p.client_id, p.role
from public.profiles p
join auth.users u on u.id = p.id
left join public.clients c on c.id = p.client_id
where p.client_id is not null and c.id is null;

-- 2. REPAIR — re-point @bahirjee.in users at the bahirjee.in client (must exist:
--    run sql/seed_bahirjee_in_domain.sql first). Admins are left alone.
update public.profiles p
   set client_id = '00000000-0000-0000-0000-0000000000b1'
  from auth.users u
 where p.id = u.id
   and lower(split_part(u.email, '@', 2)) = 'bahirjee.in'
   and p.role <> 'admin'
   and (
     p.client_id is null
     or not exists (select 1 from public.clients c where c.id = p.client_id)
   );

-- 3. REPAIR (fallback) — for any OTHER orphaned profile, null out the dangling
--    client_id (they'll be re-linked by an admin / allowlist on next login).
update public.profiles p
   set client_id = null
  from auth.users u
 where p.id = u.id
   and p.client_id is not null
   and not exists (select 1 from public.clients c where c.id = p.client_id);

-- 4. (Optional, recommended) Enforce the FK going forward so this can't recur.
--    Safe only AFTER steps 2–3 leave no orphans (step 1 returns zero rows).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'profiles_client_id_fkey' and table_name = 'profiles'
  ) then
    alter table public.profiles
      add constraint profiles_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;
