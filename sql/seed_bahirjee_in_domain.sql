-- ============================================================================
-- Seed: bahirjee.in as an approved (auto-access) client domain
-- ----------------------------------------------------------------------------
-- Any @bahirjee.in user signs in INSTANTLY (no password, no magic-link click) via
-- /api/auth-link's auto-access path. For that to attach them to an org (so they can
-- see that org's reports), a client with domain='bahirjee.in' must exist. On first
-- sign-in, handle_new_user() matches this domain and provisions their profile as a
-- client_user of this client.
--
-- Also ensure AUTO_ACCESS_DOMAINS includes bahirjee.in in env (it is the default).
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
