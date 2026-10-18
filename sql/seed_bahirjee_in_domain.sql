-- ============================================================================
-- Seed: the bahirjee.in workspace
-- ----------------------------------------------------------------------------
-- The one account allowed to sign in (LOGIN_EMAIL, default admin@bahirjee.in) is
-- attached to the client whose domain matches it. /api/auth-link refuses to sign it in
-- until this row exists.
--
-- Idempotent — safe to re-run. Run in the Supabase SQL editor AFTER schema.sql.
-- ============================================================================

insert into public.clients (id, name, domain, status, exempt_from_freemium)
values ('00000000-0000-0000-0000-0000000000b1', 'Bahirjee', 'bahirjee.in', 'active', true)
on conflict (id) do update
  set name = 'Bahirjee', domain = 'bahirjee.in', status = 'active', exempt_from_freemium = true;

-- Backfill: attach any EXISTING @bahirjee.in profiles to this client (in case they
-- signed in before the client row existed). Admins are left untouched.
do $$
declare
  bahirjee_client uuid := '00000000-0000-0000-0000-0000000000b1';
begin
  update public.profiles p
     set client_id = bahirjee_client
    from auth.users u
   where p.id = u.id
     and lower(split_part(u.email, '@', 2)) = 'bahirjee.in'
     and p.role <> 'admin'
     and (p.client_id is null or p.client_id <> bahirjee_client);
end $$;
