-- ============================================================================
-- Seed: dev bypass identity (for local DEV_AUTH_BYPASS full-pipeline testing)
-- ----------------------------------------------------------------------------
-- The local auth bypass runs as a fixed identity. To submit intelligence jobs
-- (not just build context), that identity must really exist because:
--   * intelligence_jobs.created_by is NOT NULL + FK -> auth.users
--   * jobs/reports need a real clients.id
--   * reserve_report_run reads the DB profile for freemium limits
--
-- This creates a dedicated dev client + dev user + admin/premium profile with
-- FIXED UUIDs that match the bypass in api/_auth.js and src/context/AuthContext.jsx.
-- Idempotent — safe to re-run. Run in the Supabase SQL editor.
--
-- After running, set in .env:  DEV_BYPASS_CLIENT_ID=00000000-0000-0000-0000-0000000000c1
-- ============================================================================

-- 1. Dev client (exempt from freemium so limits never block testing).
insert into public.clients (id, name, domain, status, exempt_from_freemium)
values ('00000000-0000-0000-0000-0000000000c1', 'Dev Test Client', 'bahirjee.local', 'active', true)
on conflict (id) do update
  set status = 'active', exempt_from_freemium = true;

-- 2. Dev auth user with a FIXED id (matches the bypass identity).
do $$
declare
  dev_uid uuid := '00000000-0000-0000-0000-0000000000de';
begin
  if not exists (select 1 from auth.users where id = dev_uid) then
    -- NOTE: confirmed_at is a GENERATED column (from email_confirmed_at) — never insert it.
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) values (
      '00000000-0000-0000-0000-000000000000',
      dev_uid, 'authenticated', 'authenticated', 'dev@bahirjee.local',
      crypt(gen_random_uuid()::text, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}',
      '{"full_name":"Dev Tester"}',
      false
    );
  end if;

  -- 3. Profile: admin + premium + attached to the dev client.
  --    (handle_new_user may have created a bare profile; force the fields we need.)
  insert into public.profiles (id, role, full_name, is_active, is_premium, client_id)
  values (dev_uid, 'admin', 'Dev Tester', true, true, '00000000-0000-0000-0000-0000000000c1')
  on conflict (id) do update
    set role = 'admin', is_active = true, is_premium = true,
        client_id = '00000000-0000-0000-0000-0000000000c1';

  -- Hand-inserted auth.users rows leave these token columns NULL, which makes GoTrue
  -- throw "Database error querying schema" on password login. Normalize to ''.
  update auth.users set
    confirmation_token          = coalesce(confirmation_token, ''),
    recovery_token              = coalesce(recovery_token, ''),
    email_change_token_new      = coalesce(email_change_token_new, ''),
    email_change                = coalesce(email_change, ''),
    email_change_token_current  = coalesce(email_change_token_current, ''),
    phone_change                = coalesce(phone_change, ''),
    phone_change_token          = coalesce(phone_change_token, ''),
    reauthentication_token      = coalesce(reauthentication_token, '')
  where id = dev_uid;
end $$;
