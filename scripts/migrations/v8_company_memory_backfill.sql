-- ==========================================
-- BAHIRJEE v8.0 — COMPANY MEMORY BACKFILL
-- ==========================================
-- Run this AFTER `v8_company_memory.sql`.
-- Seeds current company memory from existing reports so the new UI
-- shows continuity immediately after deploy.

-- Shared key helpers used by the backfill.
CREATE OR REPLACE FUNCTION public.normalize_memory_text(input_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    TRIM(REGEXP_REPLACE(LOWER(COALESCE($1, '')), '[^a-z0-9]+', ' ', 'g')),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.build_signal_card_key(
  section_text text,
  entity_text text,
  event_text text,
  headline_text text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    'signal:' ||
    COALESCE(public.normalize_memory_text(section_text), 'signal') || ':' ||
    CASE
      WHEN public.normalize_memory_text(entity_text) IS NOT NULL
        AND public.normalize_memory_text(event_text) IS NOT NULL
      THEN public.normalize_memory_text(entity_text) || ':' || public.normalize_memory_text(event_text)
      ELSE COALESCE(public.normalize_memory_text(headline_text), 'unknown')
    END;
$$;

CREATE OR REPLACE FUNCTION public.build_insight_card_key(
  type_text text,
  insight_text text,
  idx integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    'insight:' ||
    COALESCE(public.normalize_memory_text(type_text), 'context') || ':' ||
    COALESCE(public.normalize_memory_text(insight_text), idx::text);
$$;

CREATE OR REPLACE FUNCTION public.backfill_company_memory()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  latest_report record;
  latest_context_version_id text;
  cards_snapshot jsonb;
  sections_snapshot jsonb;
  brief_snapshot jsonb;
  memory_snapshot jsonb;
  active_card_count integer;
  recurring_card_count integer;
  signal_count integer;
  insight_count integer;
BEGIN
  FOR v_company_id IN
    SELECT DISTINCT client_id
    FROM public.reports
  LOOP
    SELECT id, created_at, context, signals, brief
    INTO latest_report
    FROM public.reports
    WHERE client_id = v_company_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    IF latest_report.id IS NULL THEN
      CONTINUE;
    END IF;

    latest_context_version_id := latest_report.context->'_startupContext'->>'context_version_id';

    -- Pass 1: upsert signal cards only.
    WITH signal_source AS (
      SELECT
        r.id AS report_id,
        r.created_at,
        s.ordinality - 1 AS source_index,
        s.signal AS payload,
        public.build_signal_card_key(
          coalesce(s.signal->>'category', s.signal->>'domain', s.signal->>'section', 'signal'),
          coalesce(s.signal->>'entity_name', s.signal->>'entity_involved', s.signal->>'entity', ''),
          coalesce(s.signal->>'event_type', s.signal->>'signal_type', s.signal->>'category', ''),
          coalesce(s.signal->>'signal_headline', s.signal->>'headline', s.signal->>'the_move', s.signal->>'signal_details', '')
        ) AS card_key,
        coalesce(s.signal->>'category', s.signal->>'domain', s.signal->>'section', 'signal') AS section_key,
        coalesce(s.signal->>'signal_headline', s.signal->>'headline', s.signal->>'the_move', s.signal->>'signal_details', 'Untitled signal') AS title,
        coalesce(s.signal->>'source_url', null) AS source_url
      FROM public.reports r
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.signals, '[]'::jsonb)) WITH ORDINALITY AS s(signal, ordinality)
      WHERE r.client_id = v_company_id
    ),
    latest_signal_source AS (
      SELECT *
      FROM signal_source
      WHERE report_id = latest_report.id
    ),
    signal_stats AS (
      SELECT
        card_key,
        count(DISTINCT report_id) AS occurrence_count,
        min(created_at) AS first_seen_at
      FROM signal_source
      GROUP BY card_key
    ),
    signal_first AS (
      SELECT DISTINCT ON (card_key)
        card_key,
        report_id AS first_seen_report_id
      FROM signal_source
      ORDER BY card_key, created_at ASC, source_index ASC, report_id ASC
    ),
    signal_cards AS (
      SELECT
        v_company_id AS company_id,
        ls.card_key,
        'signal'::text AS card_type,
        coalesce(ls.section_key, 'signal') AS section_key,
        ls.title,
        ls.payload,
        ls.source_index,
        ls.source_url,
        'active'::text AS status,
        CASE
          WHEN coalesce(ss.occurrence_count, 1) <= 1 THEN 'new'
          WHEN coalesce(ss.occurrence_count, 1) <= 2 THEN 'recurring'
          WHEN coalesce(ss.occurrence_count, 1) <= 4 THEN 'strengthening'
          ELSE 'recurring'
        END AS trend_state,
        coalesce(ss.occurrence_count, 1) AS occurrence_count,
        sf.first_seen_report_id,
        latest_report.id AS last_seen_report_id,
        coalesce(ss.first_seen_at, latest_report.created_at) AS first_seen_at,
        latest_report.created_at AS last_seen_at
      FROM latest_signal_source ls
      LEFT JOIN signal_stats ss USING (card_key)
      LEFT JOIN signal_first sf USING (card_key)
    ),
    signal_ranked AS (
      SELECT
        *,
        row_number() OVER (
          PARTITION BY company_id, card_key
          ORDER BY
            last_seen_at DESC NULLS LAST,
            source_index DESC NULLS LAST,
            occurrence_count DESC,
            title ASC
        ) AS rn
      FROM signal_cards
    )
    INSERT INTO public.brief_cards (
      company_id,
      card_key,
      section_key,
      card_type,
      title,
      payload,
      source_index,
      source_url,
      status,
      trend_state,
      occurrence_count,
      first_seen_report_id,
      last_seen_report_id,
      first_seen_at,
      last_seen_at,
      created_at,
      updated_at
    )
    SELECT
      company_id,
      card_key,
      section_key,
      card_type,
      title,
      payload,
      source_index,
      source_url,
      status,
      trend_state,
      occurrence_count,
      first_seen_report_id,
      last_seen_report_id,
      first_seen_at,
      last_seen_at,
      latest_report.created_at,
      timezone('utc'::text, now())
    FROM signal_ranked
    WHERE rn = 1
    ON CONFLICT (company_id, card_key)
    DO UPDATE SET
      section_key = EXCLUDED.section_key,
      card_type = EXCLUDED.card_type,
      title = EXCLUDED.title,
      payload = EXCLUDED.payload,
      source_index = EXCLUDED.source_index,
      source_url = EXCLUDED.source_url,
      status = EXCLUDED.status,
      trend_state = EXCLUDED.trend_state,
      occurrence_count = EXCLUDED.occurrence_count,
      first_seen_report_id = COALESCE(public.brief_cards.first_seen_report_id, EXCLUDED.first_seen_report_id),
      last_seen_report_id = EXCLUDED.last_seen_report_id,
      first_seen_at = COALESCE(public.brief_cards.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = timezone('utc'::text, now());

    -- Pass 2: upsert brief insight cards only.
    WITH insight_source AS (
      SELECT
        r.id AS report_id,
        r.created_at,
        i.ordinality - 1 AS source_index,
        i.insight AS payload,
        public.build_insight_card_key(
          coalesce(i.insight->>'type', 'context'),
          coalesce(i.insight->>'text', ''),
          (i.ordinality - 1)::integer
        ) AS card_key,
        'overview'::text AS section_key,
        coalesce(i.insight->>'text', 'Untitled insight') AS title,
        null::text AS source_url
      FROM public.reports r
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.brief->'insights', '[]'::jsonb)) WITH ORDINALITY AS i(insight, ordinality)
      WHERE r.client_id = v_company_id
    ),
    latest_insight_source AS (
      SELECT *
      FROM insight_source
      WHERE report_id = latest_report.id
    ),
    insight_stats AS (
      SELECT
        card_key,
        count(DISTINCT report_id) AS occurrence_count,
        min(created_at) AS first_seen_at
      FROM insight_source
      GROUP BY card_key
    ),
    insight_first AS (
      SELECT DISTINCT ON (card_key)
        card_key,
        report_id AS first_seen_report_id
      FROM insight_source
      ORDER BY card_key, created_at ASC, source_index ASC, report_id ASC
    ),
    insight_cards AS (
      SELECT
        v_company_id AS company_id,
        li.card_key,
        'intro'::text AS card_type,
        coalesce(li.section_key, 'overview') AS section_key,
        li.title,
        li.payload,
        li.source_index,
        li.source_url,
        'active'::text AS status,
        CASE
          WHEN coalesce(isx.occurrence_count, 1) <= 1 THEN 'new'
          WHEN coalesce(isx.occurrence_count, 1) <= 2 THEN 'recurring'
          WHEN coalesce(isx.occurrence_count, 1) <= 4 THEN 'strengthening'
          ELSE 'recurring'
        END AS trend_state,
        coalesce(isx.occurrence_count, 1) AS occurrence_count,
        ifirst.first_seen_report_id,
        latest_report.id AS last_seen_report_id,
        coalesce(isx.first_seen_at, latest_report.created_at) AS first_seen_at,
        latest_report.created_at AS last_seen_at
      FROM latest_insight_source li
      LEFT JOIN insight_stats isx USING (card_key)
      LEFT JOIN insight_first ifirst USING (card_key)
    ),
    insight_ranked AS (
      SELECT
        *,
        row_number() OVER (
          PARTITION BY company_id, card_key
          ORDER BY
            last_seen_at DESC NULLS LAST,
            source_index DESC NULLS LAST,
            occurrence_count DESC,
            title ASC
        ) AS rn
      FROM insight_cards
    )
    INSERT INTO public.brief_cards (
      company_id,
      card_key,
      section_key,
      card_type,
      title,
      payload,
      source_index,
      source_url,
      status,
      trend_state,
      occurrence_count,
      first_seen_report_id,
      last_seen_report_id,
      first_seen_at,
      last_seen_at,
      created_at,
      updated_at
    )
    SELECT
      company_id,
      card_key,
      section_key,
      card_type,
      title,
      payload,
      source_index,
      source_url,
      status,
      trend_state,
      occurrence_count,
      first_seen_report_id,
      last_seen_report_id,
      first_seen_at,
      last_seen_at,
      latest_report.created_at,
      timezone('utc'::text, now())
    FROM insight_ranked
    WHERE rn = 1
    ON CONFLICT (company_id, card_key)
    DO UPDATE SET
      section_key = EXCLUDED.section_key,
      card_type = EXCLUDED.card_type,
      title = EXCLUDED.title,
      payload = EXCLUDED.payload,
      source_index = EXCLUDED.source_index,
      source_url = EXCLUDED.source_url,
      status = EXCLUDED.status,
      trend_state = EXCLUDED.trend_state,
      occurrence_count = EXCLUDED.occurrence_count,
      first_seen_report_id = COALESCE(public.brief_cards.first_seen_report_id, EXCLUDED.first_seen_report_id),
      last_seen_report_id = EXCLUDED.last_seen_report_id,
      first_seen_at = COALESCE(public.brief_cards.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = timezone('utc'::text, now());

    SELECT
    COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'card_key', card_key,
            'section_key', section_key,
            'card_type', card_type,
            'title', title,
            'payload', payload,
            'source_index', source_index,
            'source_url', source_url,
            'status', status,
            'trend_state', trend_state,
            'occurrence_count', occurrence_count,
            'first_seen_report_id', first_seen_report_id,
            'last_seen_report_id', last_seen_report_id,
            'first_seen_at', first_seen_at,
            'last_seen_at', last_seen_at
          )
          ORDER BY section_key, card_type, title
        ),
        '[]'::jsonb
      ),
      COALESCE(to_jsonb(array_agg(DISTINCT section_key) FILTER (WHERE status = 'active')), '[]'::jsonb),
      COALESCE(count(*) FILTER (WHERE status = 'active'), 0),
      COALESCE(count(*) FILTER (WHERE status = 'active' AND occurrence_count > 1), 0),
      COALESCE(jsonb_array_length(COALESCE(latest_report.signals, '[]'::jsonb)), 0),
      COALESCE(jsonb_array_length(COALESCE(latest_report.brief->'insights', '[]'::jsonb)), 0)
    INTO cards_snapshot, sections_snapshot, active_card_count, recurring_card_count, signal_count, insight_count
    FROM public.brief_cards
    WHERE public.brief_cards.company_id = v_company_id;

    brief_snapshot := jsonb_build_object(
      'summary', COALESCE(latest_report.brief->>'bahirjee_observation', latest_report.brief->>'summary'),
      'insight_count', insight_count,
      'signal_count', signal_count,
      'active_card_count', active_card_count,
      'recurring_card_count', recurring_card_count,
      'dormant_card_count', 0,
      'top_sections', sections_snapshot
    );

    memory_snapshot := jsonb_build_object(
      'active_card_count', active_card_count,
      'recurring_card_count', recurring_card_count,
      'dormant_card_count', 0,
      'top_sections', sections_snapshot,
      'based_on_report_id', NULL,
      'context_version_id', latest_context_version_id,
      'as_of', latest_report.created_at
    );

    INSERT INTO public.company_memory_state (
      company_id,
      latest_report_id,
      latest_context_version_id,
      memory_state,
      current_brief,
      current_cards,
      active_sections,
      run_count,
      updated_at
    )
    VALUES (
      v_company_id,
      latest_report.id,
      latest_context_version_id,
      memory_snapshot,
      brief_snapshot,
      cards_snapshot,
      sections_snapshot,
      (
        SELECT COUNT(*)
        FROM public.reports r
        WHERE r.client_id = v_company_id
      ),
      timezone('utc'::text, now())
    )
    ON CONFLICT (company_id)
    DO UPDATE SET
      latest_report_id = EXCLUDED.latest_report_id,
      latest_context_version_id = EXCLUDED.latest_context_version_id,
      memory_state = EXCLUDED.memory_state,
      current_brief = EXCLUDED.current_brief,
      current_cards = EXCLUDED.current_cards,
      active_sections = EXCLUDED.active_sections,
      run_count = EXCLUDED.run_count,
      updated_at = EXCLUDED.updated_at;

    UPDATE public.reports
    SET
      memory_state = memory_snapshot,
      card_summary = cards_snapshot,
      based_on_report_id = NULL,
      run_fingerprint = 'backfill:' || latest_report.id::text,
      effective_at = latest_report.created_at,
      is_current_snapshot = true,
      superseded_by_report_id = NULL
    WHERE id = latest_report.id;
  END LOOP;
END;
$$;

SELECT public.backfill_company_memory();
