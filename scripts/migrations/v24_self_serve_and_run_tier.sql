-- ============================================================================
-- v24 — Self-serve workspaces, and a per-run depth tier
--
-- Two changes that together let a stranger with a work email sign in and get one cheap,
-- honest run without an admin provisioning them first.
--
-- 1. SELF-SERVE WORKSPACES
--
--    Until now `lib/handlers/auth-link.js` refused any email whose domain was not an
--    active `clients` row and which had no `email_allowlist` grant. The DB was already
--    more permissive than the handler — handle_new_user()'s final `else` branch assigns
--    `client_user` — but that branch was unreachable, because no auth user was ever
--    created for those addresses.
--
--    Opening the door needs more than removing the refusal. `reports.client_id` is NOT
--    NULL and the reports RLS policy reads
--        client_id in (select client_id from public.profiles where id = auth.uid())
--    which with a NULL client_id evaluates to NULL, not true. A user with no client can
--    therefore neither insert nor select a report. So a self-serve signup must land in a
--    real client row, and `clients.domain` is UNIQUE — one workspace per domain.
--
--    `self_serve` marks those auto-created workspaces so the two populations stay
--    distinguishable forever:
--      * admin-provisioned client  → a domain match still yields `brief_viewer`
--                                    (read-only), exactly as before this migration.
--      * self-serve workspace      → a domain match yields `client_user`, because these
--                                    people are here to run and to pay.
--
--    ⚠️  Members of one workspace can read each other's briefs — that is what the reports
--    RLS policy above means. For colleagues at a real company that is the feature. It is
--    also why `lib/freeMailDomains.js` excludes free-mail, disposable AND academic /
--    shared-TLD addresses: a domain that pools unrelated strangers would pool their
--    private strategic questions too. `member_cap` bounds the blast radius if one slips
--    through.
--
-- 2. RUN TIER
--
--    `run_tier` records how much research a run was allowed to do. A free run is
--    'shallow' (fewer queries, fewer deep reads, no connectors, no source watch) and a
--    paid run is 'full'. It is written from the server's reservation result and is never
--    accepted from a request body.
--
--    Default 'full' is deliberate: cron and admin runs never reserve, so they must keep
--    behaving exactly as they do today.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. Self-serve workspaces ────────────────────────────────────────────────
alter table public.clients add column if not exists self_serve boolean default false;
alter table public.clients add column if not exists seed_email text;
alter table public.clients add column if not exists member_cap integer default 25;

comment on column public.clients.self_serve is
    'True when this workspace was created by a self-serve signup rather than by an admin. '
    'Controls two things: handle_new_user() grants client_user (not brief_viewer) to domain '
    'matches here, and auth-link.js refuses to hand out an instant no-proof session for it.';
comment on column public.clients.seed_email is
    'The address whose signup created this workspace. Kept for support and abuse triage.';
comment on column public.clients.member_cap is
    'Soft ceiling on self-serve members. Past it, new domain matches degrade to brief_viewer '
    'so an unexpectedly popular domain cannot hand run budget to strangers.';

create index if not exists idx_clients_self_serve on public.clients (self_serve) where self_serve;

-- ── 2. Run tier ─────────────────────────────────────────────────────────────
alter table public.intelligence_jobs add column if not exists run_tier text default 'full';
alter table public.intelligence_jobs drop constraint if exists intelligence_jobs_run_tier_check;
alter table public.intelligence_jobs add constraint intelligence_jobs_run_tier_check
    check (run_tier in ('shallow', 'full'));

alter table public.reports add column if not exists run_tier text default 'full';
alter table public.reports drop constraint if exists reports_run_tier_check;
alter table public.reports add constraint reports_run_tier_check
    check (run_tier in ('shallow', 'full'));

-- ── 3. Role assignment for self-serve domains ───────────────────────────────
-- The ONLY change from the previous definition is the `elsif matched_client_id is not
-- null` branch. Everything else is reproduced verbatim so this file is a complete,
-- readable replacement rather than a patch that has to be mentally applied.
--
-- This function is SECURITY DEFINER and runs inside the auth.users insert. An exception
-- raised here ROLLS BACK USER CREATION, so every read below is coalesce'd and nothing
-- raises.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  user_domain text;
  matched_client_id uuid;
  allowlist_client_id uuid;
  allowlist_role text;
  allowlist_found boolean := false;
  assigned_role text;
  matched_self_serve boolean := false;
  matched_member_cap integer := 25;
  current_member_count integer := 0;
begin
  user_domain := lower(split_part(new.email, '@', 2));

  select client_id, role
    into allowlist_client_id, allowlist_role
  from public.email_allowlist
  where lower(email) = lower(new.email)
    and is_active = true;
  -- Capture immediately: the next SELECT INTO would overwrite `found`.
  allowlist_found := found;

  -- Domain match only counts for an ACTIVE client.
  select id into matched_client_id
  from public.clients
  where lower(domain) = user_domain and status = 'active';

  if allowlist_found then
    -- Explicitly provisioned (admin invite, or an approved access request):
    -- honour the role recorded on the allowlist row.
    assigned_role := coalesce(allowlist_role, 'client_user');
    matched_client_id := coalesce(allowlist_client_id, matched_client_id);
  elsif matched_client_id is not null then
    select coalesce(self_serve, false), coalesce(member_cap, 25)
      into matched_self_serve, matched_member_cap
    from public.clients
    where id = matched_client_id;

    if matched_self_serve then
      -- Self-serve workspace: a full user who can run and pay. Counted BEFORE this
      -- profile is inserted, so the cap is "existing members".
      --
      -- Deliberately advisory, unlike reserve_report_run's FOR UPDATE: two simultaneous
      -- signups can both read count = cap - 1 and both be admitted. That is acceptable
      -- because this is a blast-radius limiter, not an entitlement — nothing about
      -- spending money hangs off it. reserve_report_run remains the atomic gate.
      select count(*) into current_member_count
      from public.profiles
      where client_id = matched_client_id;

      assigned_role := case
        when current_member_count < matched_member_cap then 'client_user'
        else 'brief_viewer'
      end;
    else
      -- Admin-provisioned client. Unchanged: self-arrival by domain is read-only, and
      -- running analyses still requires an explicit invite (which creates an
      -- email_allowlist row and lands in the branch above).
      assigned_role := 'brief_viewer';
    end if;
  else
    assigned_role := 'client_user';
  end if;

  insert into public.profiles (id, full_name, role, client_id)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    assigned_role,
    matched_client_id
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
