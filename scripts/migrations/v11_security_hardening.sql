-- Migration: v11_security_hardening
-- Locks down self-service profile writes, fixes exact shared-report domain
-- matching, and adds atomic server-side report-run reservation.

-- Users must not be able to update role, client_id, premium flags, active
-- status, or run_count by updating their own profile row.
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;

CREATE OR REPLACE FUNCTION public.update_own_profile_full_name(p_full_name text)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_profile public.profiles;
BEGIN
  UPDATE public.profiles
  SET full_name = NULLIF(TRIM(p_full_name), ''),
      updated_at = timezone('utc'::text, now())
  WHERE id = auth.uid()
  RETURNING * INTO updated_profile;

  IF updated_profile.id IS NULL THEN
    RAISE EXCEPTION 'profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN updated_profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_own_profile_full_name(text) TO authenticated;

DROP POLICY IF EXISTS "Domain users view shared reports" ON public.reports;
CREATE POLICY "Domain users view shared reports" ON public.reports FOR SELECT
USING (
  target_domain IS NOT NULL AND
  lower(split_part(auth.jwt() ->> 'email', '@', 2)) = lower(target_domain)
);

CREATE OR REPLACE FUNCTION public.reserve_report_run(p_user_id uuid, p_website_url text)
RETURNS TABLE(allowed boolean, run_count integer, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_profile public.profiles;
  client_exempt boolean := false;
BEGIN
  SELECT *
    INTO target_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF target_profile.id IS NULL OR target_profile.is_active IS FALSE THEN
    RETURN QUERY SELECT false, 0, 'user_not_allowed';
    RETURN;
  END IF;

  SELECT coalesce(exempt_from_freemium, false)
    INTO client_exempt
  FROM public.clients
  WHERE id = target_profile.client_id;

  IF target_profile.role = 'admin' OR coalesce(target_profile.is_premium, false) OR client_exempt THEN
    RETURN QUERY SELECT true, target_profile.run_count, 'unlimited';
    RETURN;
  END IF;

  IF coalesce(target_profile.run_count, 0) >= 1 THEN
    RETURN QUERY SELECT false, target_profile.run_count, 'report_limit_reached';
    RETURN;
  END IF;

  UPDATE public.profiles
  SET run_count = coalesce(public.profiles.run_count, 0) + 1,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_user_id
  RETURNING public.profiles.run_count INTO target_profile.run_count;

  RETURN QUERY SELECT true, target_profile.run_count, 'reserved';
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_report_run(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.reserve_report_run(uuid, text) FROM authenticated;

-- Harden legacy manual increment RPC if it exists. The frontend no longer uses
-- it for run gating, but direct callers must not increment another user's row.
CREATE OR REPLACE FUNCTION public.increment_run_count(p_user_id uuid)
RETURNS TABLE(id uuid, run_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.profiles
  SET run_count = COALESCE(run_count, 0) + 1,
      updated_at = timezone('utc'::text, now())
  WHERE id = auth.uid()
    AND p_user_id = auth.uid()
  RETURNING id, run_count;
$$;

CREATE OR REPLACE FUNCTION public.enforce_interaction_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count integer;
  viewer_is_premium boolean := false;
BEGIN
  IF new.interaction_type NOT IN ('question', 'note') THEN
    RETURN new;
  END IF;

  SELECT coalesce(p.is_premium, false)
      OR coalesce(c.exempt_from_freemium, false)
    INTO viewer_is_premium
  FROM public.profiles p
  LEFT JOIN public.clients c ON c.id = p.client_id
  WHERE p.id = new.user_id;

  IF viewer_is_premium THEN
    RETURN new;
  END IF;

  SELECT count(*)
    INTO existing_count
  FROM public.interactions
  WHERE report_id = new.report_id
    AND user_id = new.user_id
    AND interaction_type = new.interaction_type;

  IF existing_count >= 3 THEN
    RAISE EXCEPTION 'interaction limit reached for %', new.interaction_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN new;
END;
$$;
