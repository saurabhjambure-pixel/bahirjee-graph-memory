/**
 * Temporal policy tests — the date semantics every downstream surface depends on.
 *
 * This module answers one question: given a piece of evidence, is it a CURRENT event,
 * explanatory CONTEXT, or HISTORICAL background? Everything else in the temporal feature
 * (retrieval windows, news gating, card labels) reads that answer rather than re-deriving
 * it, so the rules are pinned here rather than trusted.
 *
 * The failure this guards against is the one this codebase keeps paying for: nothing
 * throws, and the brief is just quietly wrong. A 2024 article stamped with today's
 * ingestion time reads as news. No error is raised anywhere.
 *
 * Run: node scripts/temporal-policy.test.mjs
 */
import assert from 'node:assert/strict'

import {
  buildTemporalPolicy,
  classifyEvidenceDate,
  buildDateWindowParams,
  isCurrentAnchor,
  normalizeIsoDate,
  subtractCalendarMonths,
} from '../src/services/temporalPolicy.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

// A fixed clock. Every expectation below is written against this date, so a test that
// starts failing in six months is a real regression and not a calendar drift.
const NOW = new Date('2026-09-19T11:30:00.000Z')
const POLICY = buildTemporalPolicy(NOW)

// ─── calendar arithmetic ────────────────────────────────────────────────────
// Months, not months × 30. "Six months back from September 19th" has to land on
// March 19th, because that is the boundary we will have to explain to a founder.

console.log('\ncalendar month arithmetic')

check('six months back is a calendar month, not 180 days', () => {
  assert.equal(subtractCalendarMonths(new Date('2026-09-19T00:00:00Z'), 6), '2026-03-19')
})

check('twelve months back lands on the same day one year earlier', () => {
  assert.equal(subtractCalendarMonths(new Date('2026-09-19T00:00:00Z'), 12), '2025-09-19')
})

check('a short target month clamps instead of overflowing', () => {
  // March 31 minus one month is not "February 31" and must not roll into March 3.
  assert.equal(subtractCalendarMonths(new Date('2026-03-31T00:00:00Z'), 1), '2026-02-28')
})

check('a leap year is respected when clamping', () => {
  assert.equal(subtractCalendarMonths(new Date('2028-03-31T00:00:00Z'), 1), '2028-02-29')
})

check('subtraction crosses a year boundary', () => {
  assert.equal(subtractCalendarMonths(new Date('2026-02-10T00:00:00Z'), 6), '2025-08-10')
})

// ─── policy shape ───────────────────────────────────────────────────────────

console.log('\npolicy construction')

check('the current window is six calendar months ending today', () => {
  assert.equal(POLICY.current.months, 6)
  assert.equal(POLICY.current.startDate, '2026-03-19')
  assert.equal(POLICY.current.endDate, '2026-09-19')
})

check('the context window is twelve calendar months ending today', () => {
  assert.equal(POLICY.context.months, 12)
  assert.equal(POLICY.context.startDate, '2025-09-19')
  assert.equal(POLICY.context.endDate, '2026-09-19')
})

check('historical evidence is retained and fetched on demand, never bounded away', () => {
  assert.equal(POLICY.historical.mode, 'on_demand')
})

check('the policy defaults to a real clock when none is supplied', () => {
  const live = buildTemporalPolicy()
  assert.match(live.current.startDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(live.context.startDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(live.context.startDate < live.current.startDate)
})

// ─── strict date parsing ────────────────────────────────────────────────────
// Fuzzy dates are worse than no date: "Q3 2024" parsed optimistically becomes a
// confident wrong answer. Missing beats wrong (internal design log).

console.log('\nstrict ISO date normalisation')

check('a bare ISO day is accepted', () => {
  assert.equal(normalizeIsoDate('2026-04-01'), '2026-04-01')
})

check('an ISO timestamp is truncated to its day', () => {
  assert.equal(normalizeIsoDate('2026-04-01T09:14:22.000Z'), '2026-04-01')
})

check('a Date instance is accepted', () => {
  assert.equal(normalizeIsoDate(new Date('2026-04-01T00:00:00Z')), '2026-04-01')
})

check('fuzzy human dates are rejected rather than guessed', () => {
  for (const fuzzy of ['Q3 2024', 'last spring', 'March 2024', '2024', 'yesterday']) {
    assert.equal(normalizeIsoDate(fuzzy), null, `expected null for ${fuzzy}`)
  }
})

check('impossible and empty values are rejected', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '', null, undefined, {}, NaN]) {
    assert.equal(normalizeIsoDate(bad), null)
  }
})

// ─── date precedence ────────────────────────────────────────────────────────

console.log('\ndate precedence')

check('the event date wins over the publication date', () => {
  const c = classifyEvidenceDate(
    { eventDate: '2026-05-02', publishedDate: '2026-08-30', retrievedAt: '2026-09-19' },
    POLICY
  )
  assert.equal(c.effectiveDate, '2026-05-02')
  assert.equal(c.dateKind, 'event')
  assert.equal(c.dateConfidence, 'high')
})

check('the publication date is the fallback when no event date exists', () => {
  const c = classifyEvidenceDate(
    { eventDate: null, publishedDate: '2026-08-30', retrievedAt: '2026-09-19' },
    POLICY
  )
  assert.equal(c.effectiveDate, '2026-08-30')
  assert.equal(c.dateKind, 'published')
  assert.equal(c.dateConfidence, 'medium')
})

check('retrieval time is NEVER used as an event date', () => {
  // This is the whole bug. A 2024 page fetched today is not a 2026 event.
  const c = classifyEvidenceDate(
    { eventDate: null, publishedDate: null, retrievedAt: '2026-09-19T11:30:00Z' },
    POLICY
  )
  assert.equal(c.effectiveDate, null)
  assert.equal(c.dateKind, null)
  assert.notEqual(c.temporalRole, 'anchor')
})

check('a fuzzy event date falls through to the publication date', () => {
  const c = classifyEvidenceDate(
    { eventDate: 'Q2 2026', publishedDate: '2026-07-04', retrievedAt: '2026-09-19' },
    POLICY
  )
  assert.equal(c.effectiveDate, '2026-07-04')
  assert.equal(c.dateKind, 'published')
})

// ─── role classification ────────────────────────────────────────────────────

console.log('\ntemporal role classification')

check('an event inside six months is a current anchor', () => {
  const c = classifyEvidenceDate({ eventDate: '2026-07-11' }, POLICY)
  assert.equal(c.temporalRole, 'anchor')
  assert.equal(isCurrentAnchor(c), true)
  assert.equal(c.ageDays, 70)
})

check('an event between six and twelve months is supporting context', () => {
  const c = classifyEvidenceDate({ eventDate: '2025-12-01' }, POLICY)
  assert.equal(c.temporalRole, 'supporting_context')
  assert.equal(isCurrentAnchor(c), false)
})

check('an event older than twelve months is historical context', () => {
  const c = classifyEvidenceDate({ eventDate: '2024-03-04' }, POLICY)
  assert.equal(c.temporalRole, 'historical_context')
  assert.equal(isCurrentAnchor(c), false)
})

check('the six-month boundary date itself is current (inclusive)', () => {
  assert.equal(classifyEvidenceDate({ eventDate: '2026-03-19' }, POLICY).temporalRole, 'anchor')
})

check('one day before the six-month boundary is context, not current', () => {
  assert.equal(
    classifyEvidenceDate({ eventDate: '2026-03-18' }, POLICY).temporalRole,
    'supporting_context'
  )
})

check('the twelve-month boundary date itself is still context (inclusive)', () => {
  assert.equal(
    classifyEvidenceDate({ eventDate: '2025-09-19' }, POLICY).temporalRole,
    'supporting_context'
  )
})

check('one day before the twelve-month boundary is historical', () => {
  assert.equal(
    classifyEvidenceDate({ eventDate: '2025-09-18' }, POLICY).temporalRole,
    'historical_context'
  )
})

check('today is current', () => {
  assert.equal(classifyEvidenceDate({ eventDate: '2026-09-19' }, POLICY).temporalRole, 'anchor')
})

// ─── undated evidence ───────────────────────────────────────────────────────

console.log('\nundated evidence')

check('an undated page is supporting context, never a current anchor', () => {
  // The general web index returns no published_date at all. Those pages must not
  // become news on the strength of having been crawled today.
  const c = classifyEvidenceDate(
    { eventDate: null, publishedDate: null, retrievedAt: '2026-09-19', sourceType: 'tavily' },
    POLICY
  )
  assert.equal(c.temporalRole, 'supporting_context')
  assert.equal(c.dateConfidence, 'low')
  assert.equal(c.ageDays, null)
  assert.equal(isCurrentAnchor(c), false)
})

// ─── the one legitimate use of ingestion time ───────────────────────────────

console.log('\nfirst-party observed change')

check('a source-watch diff IS a current anchor dated at observation', () => {
  // Source Watch emits only where the content hash CHANGED since the last run. The
  // diff itself is the evidence that the change is new, so ingestion time is a real
  // event time here — the only place in the pipeline where that is true.
  const c = classifyEvidenceDate(
    {
      eventDate: null,
      publishedDate: null,
      retrievedAt: '2026-09-19T11:30:00Z',
      sourceClass: 'primary_company',
      observedChange: true,
    },
    POLICY
  )
  assert.equal(c.temporalRole, 'anchor')
  assert.equal(c.effectiveDate, '2026-09-19')
  assert.equal(c.dateKind, 'event')
  assert.equal(c.dateConfidence, 'medium')
  assert.equal(isCurrentAnchor(c), true)
})

check('an observed change does not upgrade a dated historical source', () => {
  const c = classifyEvidenceDate(
    { eventDate: '2024-01-05', observedChange: true, sourceClass: 'primary_company' },
    POLICY
  )
  assert.equal(c.effectiveDate, '2024-01-05')
  assert.equal(c.temporalRole, 'historical_context')
})

check('an undated non-watch primary page is not promoted by its source class alone', () => {
  const c = classifyEvidenceDate(
    { sourceClass: 'primary_company', observedChange: false, retrievedAt: '2026-09-19' },
    POLICY
  )
  assert.notEqual(c.temporalRole, 'anchor')
})

// ─── future dates ───────────────────────────────────────────────────────────

console.log('\nfuture dates')

check('a date in the future is not a current anchor and not historical', () => {
  // An unverifiable future date must not anchor current news, but calling it
  // "historical" would be absurd. It supports, with low confidence.
  const c = classifyEvidenceDate({ eventDate: '2027-02-01' }, POLICY)
  assert.equal(c.temporalRole, 'supporting_context')
  assert.equal(c.dateConfidence, 'low')
  assert.equal(isCurrentAnchor(c), false)
})

// ─── provider window parameters ─────────────────────────────────────────────

console.log('\nprovider date window parameters')

check('a news-topic current window is expressed in days', () => {
  const p = buildDateWindowParams('current', POLICY, 'news')
  assert.equal(typeof p.days, 'number')
  assert.equal(p.days, 184) // 2026-03-19 → 2026-09-19
  assert.equal(p.start_date, undefined)
})

check('a general-topic current window is expressed as start and end dates', () => {
  const p = buildDateWindowParams('current', POLICY, 'general')
  assert.equal(p.start_date, '2026-03-19')
  assert.equal(p.end_date, '2026-09-19')
  assert.equal(p.days, undefined)
})

check('a general-topic context window spans twelve months', () => {
  const p = buildDateWindowParams('context', POLICY, 'general')
  assert.equal(p.start_date, '2025-09-19')
  assert.equal(p.end_date, '2026-09-19')
})

check('a profile window is unbounded so entity pages are not filtered out by date', () => {
  // Context assembly wants the company's own undated homepage. A date window on
  // topic 'general' filters undated pages OUT, so profile lookups send none.
  assert.deepEqual(buildDateWindowParams('profile', POLICY, 'general'), {})
  assert.deepEqual(buildDateWindowParams('profile', POLICY, 'news'), {})
})

check('an unknown window name is treated as unbounded rather than guessed', () => {
  assert.deepEqual(buildDateWindowParams('nonsense', POLICY, 'general'), {})
})

// ─── guard rails ────────────────────────────────────────────────────────────

console.log('\nguard rails')

check('classification never mutates its input', () => {
  const input = { eventDate: '2026-07-11', publishedDate: '2026-07-20' }
  const before = JSON.stringify(input)
  classifyEvidenceDate(input, POLICY)
  assert.equal(JSON.stringify(input), before)
})

check('classification tolerates a missing evidence object', () => {
  const c = classifyEvidenceDate(null, POLICY)
  assert.equal(c.effectiveDate, null)
  assert.notEqual(c.temporalRole, 'anchor')
})

check('isCurrentAnchor rejects an undated row even if it claims to be an anchor', () => {
  assert.equal(isCurrentAnchor({ temporalRole: 'anchor', effectiveDate: null }), false)
  assert.equal(isCurrentAnchor(null), false)
  assert.equal(isCurrentAnchor({ temporalRole: 'anchor', effectiveDate: '2026-07-01' }), true)
})

console.log(`\n${passed} checks passed`)
if (process.exitCode) console.error('FAILED')
