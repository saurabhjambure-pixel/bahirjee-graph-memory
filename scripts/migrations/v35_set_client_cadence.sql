-- ============================================================================
-- v35 — Let a founder set their own reading cadence
--
-- `clients.auto_run_cadence` has existed since v18 and has never been settable by
-- anyone. The cron reads it, the CadenceBar displays it, and nothing writes it — which
-- is why it is NULL on every client in production, why /api/cron-runs has fired every
-- Monday since v18 and queued nothing, and why no job has ever carried
-- job_origin='scheduled'. The whole "agent that works between visits" premise has never
-- once run, for want of one UPDATE.
--
-- WHY AN RPC AND NOT AN UPDATE POLICY. Two reasons, and the second is the important one.
--
--   1. RLS on `clients` grants non-admins SELECT only ("Users view own client"). A plain
--      client-side UPDATE would match zero rows and return success with empty data —
--      the founder toggles the control, nothing happens, and nothing reports an error.
--      A column-level GRANT plus an UPDATE policy would fix that, but not (2).
--
--   2. TURNING A CADENCE ON SPENDS MONEY EVERY WEEK, AND SCHEDULED RUNS DO NOT COUNT
--      AGAINST THE FREEMIUM QUOTA. cron-runs passes `reservedRun: false` deliberately —
--      a founder who did not click anything must not burn their single free run. The
--      consequence is that a FREE account on a weekly cadence would receive ~52 full
--      runs a year, at ~$0.30 each, entirely unbilled. Entitlement therefore has to be
--      enforced server-side, where the client cannot reach it — the same discipline as
--      reserve_report_run, and the same reason run tier is never read from a request
--      body.
--
-- Turning a cadence OFF is always permitted, for anyone who belongs to the client. A
-- paywall that traps someone into spending is not a paywall, it is a subscription trap.
--
-- Admins are unaffected and need no new grant: "Admins all clients" already covers them.
--
-- DEPENDENCIES: v18 (the column + its CHECK), v24 (clients.exempt_from_freemium is older,
-- profiles.is_premium older still). Independent of v26-v28.
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_client_cadence(
    p_client_id UUID,
    p_cadence   TEXT
)
RETURNS public.clients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row      public.clients;
    v_is_admin BOOLEAN;
    v_member   BOOLEAN;
    v_entitled BOOLEAN;
BEGIN
    -- Validate against the SAME value set as the v18 CHECK. Duplicated deliberately so a
    -- bad value is refused with a readable message instead of a constraint violation —
    -- but if you widen one, widen the other in the same commit. v25 is the cautionary
    -- tale: a CHECK frozen while the code moved on rejected every row silently for months.
    IF p_cadence IS NOT NULL AND p_cadence NOT IN ('off', 'weekly', 'monthly') THEN
        RAISE EXCEPTION 'invalid cadence: %', p_cadence;
    END IF;

    v_is_admin := public.is_admin();

    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND client_id = p_client_id AND is_active
    ) INTO v_member;

    IF NOT (v_is_admin OR v_member) THEN
        RAISE EXCEPTION 'not authorised to set the cadence for this client';
    END IF;

    -- Entitlement gate. Only on the way ON — see the header.
    IF NOT v_is_admin AND COALESCE(p_cadence, 'off') <> 'off' THEN
        SELECT COALESCE(p.is_premium, FALSE) OR COALESCE(c.exempt_from_freemium, FALSE)
          INTO v_entitled
          FROM public.profiles p
          LEFT JOIN public.clients c ON c.id = p.client_id
         WHERE p.id = auth.uid();

        IF NOT COALESCE(v_entitled, FALSE) THEN
            RAISE EXCEPTION 'a standing read requires a premium workspace';
        END IF;
    END IF;

    UPDATE public.clients
       SET auto_run_cadence = p_cadence
     WHERE id = p_client_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'client not found: %', p_client_id;
    END IF;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_client_cadence(UUID, TEXT) TO authenticated;
