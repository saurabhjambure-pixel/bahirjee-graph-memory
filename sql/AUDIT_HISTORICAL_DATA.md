# Historical Data Audit Report
## Phase 1: Understanding Existing Data for Paynearby, Caremother, Avegen

**Purpose**: Understand what intelligence analysis data exists in the database for these three companies, and what historical patterns have already been discovered.

**Date**: 2026-03-21

---

## Part A: Reports Inventory

### Query A1: Find all reports for the three companies
Run this in your Supabase SQL editor:

```sql
SELECT
  r.id,
  r.client_id,
  r.website_url,
  r.target_domain,
  r.created_at,
  r.created_by,
  array_length(r.signals, 1) as signal_count,
  r.context->>'company_name' as company_name,
  r.context->>'industry' as industry,
  r.brief->>'summary' as brief_summary,
  r.share_token
FROM public.reports r
WHERE r.target_domain IN ('paynearby.com', 'caremother.com', 'avegen.com')
   OR r.website_url ILIKE ANY(ARRAY['%paynearby%', '%caremother%', '%avegen%'])
ORDER BY r.created_at DESC;
```

**Expected output**:
- Rows per company (how many historical reports exist)
- Date range of reports
- Signal counts per report
- Company metadata extracted from context

---

### Query A2: Reports Summary by Company

```sql
SELECT
  COALESCE(r.target_domain, r.website_url) as company,
  COUNT(*) as total_reports,
  MIN(r.created_at) as first_report_date,
  MAX(r.created_at) as latest_report_date,
  AVG(array_length(r.signals, 1)) as avg_signals_per_report,
  COUNT(DISTINCT r.client_id) as unique_clients
FROM public.reports r
WHERE r.target_domain IN ('paynearby.com', 'caremother.com', 'avegen.com')
   OR r.website_url ILIKE ANY(ARRAY['%paynearby%', '%caremother%', '%avegen%'])
GROUP BY COALESCE(r.target_domain, r.website_url)
ORDER BY total_reports DESC;
```

**Expected output**:
- Reports per company
- Timeline span
- Average signals per run
- Multi-client usage

---

### Query A3: All Signals from Reports (Top 100)

```sql
SELECT
  r.target_domain,
  r.created_at,
  s->>'signal_headline' as headline,
  s->>'category' as signal_category,
  s->>'the_move' as the_move,
  s->>'confidence' as confidence,
  s->>'entity_involved' as entity,
  s->>'timing_window' as timing_window,
  s->>'source_url' as source_url
FROM public.reports r,
  LATERAL jsonb_array_elements(r.signals) as s
WHERE r.target_domain IN ('paynearby.com', 'caremother.com', 'avegen.com')
   OR r.website_url ILIKE ANY(ARRAY['%paynearby%', '%caremother%', '%avegen%'])
ORDER BY r.created_at DESC, s->>'signal_headline'
LIMIT 100;
```

**Expected output**:
- Detailed signal breakdown
- Signal categories discovered
- Confidence levels
- Timing windows (immediate/short-term/medium-term)

---

### Query A4: Recurring Signals (Appearing in Multiple Reports)

```sql
WITH signal_list AS (
  SELECT
    r.target_domain,
    s->>'signal_headline' as headline,
    s->>'category' as category,
    COUNT(*) as occurrence_count,
    COUNT(DISTINCT r.id) as report_count,
    STRING_AGG(DISTINCT TO_CHAR(r.created_at, 'YYYY-MM-DD'), ', ' ORDER BY TO_CHAR(r.created_at, 'YYYY-MM-DD')) as report_dates,
    MAX(r.created_at) as latest_date
  FROM public.reports r,
    LATERAL jsonb_array_elements(r.signals) as s
  WHERE r.target_domain IN ('paynearby.com', 'caremother.com', 'avegen.com')
     OR r.website_url ILIKE ANY(ARRAY['%paynearby%', '%caremother%', '%avegen%'])
  GROUP BY r.target_domain, s->>'signal_headline', s->>'category'
)
SELECT *
FROM signal_list
WHERE report_count > 1  -- Only show signals appearing in multiple reports
ORDER BY report_count DESC, latest_date DESC;
```

**Expected output**:
- Signals that recur across multiple reports (pattern indicators)
- How many times each recurring signal appears
- Timeline of when recurring signals were detected

---

## Part B: Observations Table Analysis

### Query B1: Observation Count by Company

```sql
SELECT
  entity,
  COUNT(*) as total_observations,
  COUNT(DISTINCT theme) as unique_themes,
  COUNT(DISTINCT source_url) as unique_sources,
  MIN(created_at) as oldest_obs,
  MAX(created_at) as newest_obs,
  ROUND((MAX(created_at)::DATE - MIN(created_at)::DATE)::NUMERIC / 30, 1) as months_of_data
FROM public.observations
WHERE entity IN ('Paynearby', 'Caremother', 'Avegen')
GROUP BY entity
ORDER BY total_observations DESC;
```

**Expected output**:
- Observation volume per company
- Theme variety (how many different signal themes have been tracked)
- Source diversity
- Data recency

---

### Query B2: Observations by Theme (Top 20)

```sql
SELECT
  entity,
  theme,
  COUNT(*) as observation_count,
  COUNT(DISTINCT source_url) as source_diversity,
  MIN(created_at) as first_seen,
  MAX(created_at) as last_seen,
  ROUND((MAX(created_at)::DATE - MIN(created_at)::DATE)::NUMERIC, 0) as days_span
FROM public.observations
WHERE entity IN ('Paynearby', 'Caremother', 'Avegen')
GROUP BY entity, theme
ORDER BY observation_count DESC
LIMIT 20;
```

**Expected output**:
- Themes with highest observation volume
- How long each theme has been tracked
- Source diversity (pattern indicator)

---

### Query B3: Observation Velocity (Recent vs. Older)

```sql
WITH obs_timeline AS (
  SELECT
    entity,
    theme,
    created_at,
    CASE
      WHEN created_at >= NOW() - INTERVAL '7 days' THEN 'last_7_days'
      WHEN created_at >= NOW() - INTERVAL '30 days' THEN 'last_30_days'
      WHEN created_at >= NOW() - INTERVAL '90 days' THEN 'last_90_days'
      ELSE 'older'
    END as time_bucket
  FROM public.observations
  WHERE entity IN ('Paynearby', 'Caremother', 'Avegen')
)
SELECT
  entity,
  theme,
  COUNT(CASE WHEN time_bucket = 'last_7_days' THEN 1 END) as count_last_7d,
  COUNT(CASE WHEN time_bucket = 'last_30_days' THEN 1 END) as count_last_30d,
  COUNT(CASE WHEN time_bucket = 'last_90_days' THEN 1 END) as count_last_90d,
  COUNT(CASE WHEN time_bucket = 'older' THEN 1 END) as count_older,
  ROUND(
    (COUNT(CASE WHEN time_bucket IN ('last_7_days', 'last_30_days') THEN 1 END)::NUMERIC) /
    NULLIF(COUNT(CASE WHEN time_bucket = 'older' THEN 1 END), 0),
    2
  ) as velocity_ratio
FROM obs_timeline
GROUP BY entity, theme
ORDER BY entity, COUNT(*) DESC;
```

**Expected output**:
- Velocity of observations (accelerating vs. decelerating)
- Recent activity intensity
- Pattern maturity (velocity < 0.5 = early, 0.5-2 = forming, > 2 = established)

---

## Part C: Patterns Table Analysis

### Query C1: Patterns Summary

```sql
SELECT
  company_id,
  entity,
  theme,
  maturity,
  velocity_score,
  source_diversity,
  observation_count,
  first_seen,
  last_seen,
  created_at as pattern_detected_at,
  updated_at as pattern_last_updated
FROM public.patterns
WHERE entity IN ('Paynearby', 'Caremother', 'Avegen')
ORDER BY entity, observation_count DESC;
```

**Expected output**:
- Identified patterns by company
- Pattern maturity levels (early/forming/established)
- When patterns were detected and updated

---

### Query C2: High-Confidence Patterns (Established or Forming)

```sql
SELECT
  entity,
  theme,
  maturity,
  ROUND(velocity_score::NUMERIC, 2) as velocity_score,
  source_diversity,
  observation_count,
  ROUND((NOW()::DATE - last_seen::DATE)::NUMERIC, 0) as days_since_last_obs,
  STRING_AGG(DISTINCT entity_names, ', ') as entities_involved
FROM public.patterns
WHERE entity IN ('Paynearby', 'Caremother', 'Avegen')
  AND maturity IN ('forming', 'established')
ORDER BY entity, velocity_score DESC;
```

**Expected output**:
- Patterns with significance (forming/established)
- Which entities/competitors are involved
- Recency (how current the pattern is)

---

## Part D: Gap Analysis

### Query D1: Check for missing reports or gaps

```sql
SELECT
  r.target_domain,
  DATE(r.created_at) as report_date,
  COUNT(*) as reports_this_date,
  LAG(r.created_at) OVER (PARTITION BY r.target_domain ORDER BY r.created_at) as previous_report_date,
  ROUND((r.created_at - LAG(r.created_at) OVER (PARTITION BY r.target_domain ORDER BY r.created_at))::NUMERIC / 86400, 0) as days_since_previous
FROM public.reports r
WHERE r.target_domain IN ('paynearby.com', 'caremother.com', 'avegen.com')
   OR r.website_url ILIKE ANY(ARRAY['%paynearby%', '%caremother%', '%avegen%'])
GROUP BY r.target_domain, DATE(r.created_at), r.created_at
ORDER BY r.target_domain, r.created_at DESC;
```

**Expected output**:
- Analysis frequency
- Time gaps between runs
- Consistency of monitoring

---

## Part E: Recommendations Based on Audit

After running all queries, answer these questions:

1. **Data Volume**: How many reports exist per company?
   - [ ] < 3 reports (sparse data)
   - [ ] 3-10 reports (good history)
   - [ ] > 10 reports (rich history)

2. **Pattern Richness**: How many distinct themes/patterns emerged?
   - [ ] < 5 themes (limited patterns)
   - [ ] 5-15 themes (moderate patterns)
   - [ ] > 15 themes (rich pattern library)

3. **Recurring Signals**: Are signals repeating across reports?
   - [ ] < 20% recurrence (mostly new signals each time)
   - [ ] 20-50% recurrence (some established patterns)
   - [ ] > 50% recurrence (strong recurring themes)

4. **Observation Data Quality**: How extensive is the observations table?
   - [ ] Empty or sparse (no observations tracked)
   - [ ] Partial (some observations recorded)
   - [ ] Complete (rich observation history)

5. **Readiness for Phase 2**:
   - If you have > 3 reports per company AND > 5 themes AND > 50% recurrence → **Ready for Phase 2**
   - Otherwise → Consider running more analyses before Phase 2 integration

---

## Next Steps

After completing this audit:

1. **Document findings** in a summary below
2. **Share results** with the implementation team
3. **Proceed to Phase 2** if data volume is sufficient
4. **Consider backfilling** observations if data is sparse

---

## Audit Results Summary

**Run Date**: _______________
**Auditor**: _______________

### Paynearby
- Reports: _____ (First: _______, Latest: _______)
- Avg Signals/Report: _____
- Unique Themes: _____
- Recurring Signals: _____ %
- Status: ________________

### Caremother
- Reports: _____ (First: _______, Latest: _______ )
- Avg Signals/Report: _____
- Unique Themes: _____
- Recurring Signals: _____ %
- Status: ________________

### Avegen
- Reports: _____ (First: _______, Latest: _______ )
- Avg Signals/Report: _____
- Unique Themes: _____
- Recurring Signals: _____ %
- Status: ________________

### Overall Assessment
______________________________________________________________________________

### Recommendation for Phase 2
______________________________________________________________________________

### Data Quality Issues Found
______________________________________________________________________________
