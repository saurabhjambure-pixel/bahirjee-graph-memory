-- ============================================================================
-- Seed: default admin account (password login)
-- ----------------------------------------------------------------------------
-- Admins sign in with a PASSWORD at /admin/login (never a magic link). This seed
-- ensures admin@bahirjee.in exists, is an active admin, and has a known password.
-- Idempotent — safe to re-run. Run in the Supabase SQL editor.
--
-- ⚠️  The password below ('Bahirjee@2026') is a suggested TESTING DEFAULT. Change it
--     in production (sign in, then use /admin/reset, or re-run this with a new value).
--
-- Notes:
--   * email_allowlist role='admin' makes /api/auth-link SUPPRESS instant/magic-link
--     access for this address (admins use the password page), and drives handle_new_user().
--   * Also set ADMIN_EMAILS=admin@bahirjee.in in .env / Vercel.
-- ============================================================================

-- 0. Retire the old bahirjee.ai admin (domain change → bahirjee.in).
update public.email_allowlist set is_active = false where lower(email) = 'admin@bahirjee.ai';
do $$
declare old_uid uuid;
begin
  select id into old_uid from auth.users where lower(email) = 'admin@bahirjee.ai';
  if old_uid is not null then
    update public.profiles set is_active = false where id = old_uid;
  end if;
end $$;

-- 1. Allowlist row (admin role).
insert into public.email_allowlist (email, role, is_active, client_id)
values ('admin@bahirjee.in', 'admin', true, null)
on conflict (email) do update
  set role = 'admin', is_active = true, client_id = null;

-- 2. Ensure the auth user exists and has the known password + is confirmed,
--    then ensure an active admin profile.
do $$
declare
  admin_uid uuid;
begin
  select id into admin_uid from auth.users where lower(email) = 'admin@bahirjee.in';

  if admin_uid is null then
    admin_uid := gen_random_uuid();
    -- NOTE: confirmed_at is a GENERATED column (from email_confirmed_at) — never insert it.
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) values (
      '00000000-0000-0000-0000-000000000000',
      admin_uid, 'authenticated', 'authenticated', 'admin@bahirjee.in',
      crypt('Bahirjee@2026', gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}',
      '{"full_name":"System Admin"}',
      false
    );
  else
    update auth.users
       set encrypted_password = crypt('Bahirjee@2026', gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = admin_uid;
  end if;

  insert into public.profiles (id, role, full_name, is_active)
  values (admin_uid, 'admin', 'System Admin', true)
  on conflict (id) do update
    set role = 'admin', is_active = true;

  -- Hand-inserted auth.users rows leave these token columns NULL, which makes
  -- GoTrue throw "Database error querying schema" on password login. Normalize to ''.
  update auth.users set
    confirmation_token          = coalesce(confirmation_token, ''),
    recovery_token              = coalesce(recovery_token, ''),
    email_change_token_new      = coalesce(email_change_token_new, ''),
    email_change                = coalesce(email_change, ''),
    email_change_token_current  = coalesce(email_change_token_current, ''),
    phone_change                = coalesce(phone_change, ''),
    phone_change_token          = coalesce(phone_change_token, ''),
    reauthentication_token      = coalesce(reauthentication_token, '')
  where id = admin_uid;
end $$;
