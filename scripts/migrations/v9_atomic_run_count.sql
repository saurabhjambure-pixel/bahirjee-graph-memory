-- Migration: v9_atomic_run_count
-- Adds a SECURITY DEFINER RPC function for atomic run_count increment.
-- Replaces the fetch-then-update pattern in reportService.js which is
-- prone to race conditions when concurrent reports are created.

CREATE OR REPLACE FUNCTION public.increment_run_count(p_user_id uuid)
RETURNS TABLE(id uuid, run_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.profiles
  SET run_count = COALESCE(run_count, 0) + 1
  WHERE id = auth.uid()
    AND p_user_id = auth.uid()
  RETURNING id, run_count;
$$;

-- Grant execute to authenticated users (RLS on profiles still applies)
GRANT EXECUTE ON FUNCTION public.increment_run_count(uuid) TO authenticated;
