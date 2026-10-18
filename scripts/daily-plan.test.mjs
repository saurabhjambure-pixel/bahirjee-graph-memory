/**
 * The daily plan — silence, budget, and the guard rail on the model.
 *
 * The single most important property here is that A QUIET DAY IS A CORRECT DAY. The whole
 * argument for a daily agent is that it spends almost nothing on almost every morning and
 * speaks only when something clears a bar. If `planDailyWork` drifts toward always finding
 * a reason to climb the ladder, the product becomes the thing it was built to replace —
 * the entire pipeline running on a faster cadence — and nothing throws to say so.
 *
 * The second is that THE MODEL CANNOT INVENT WORK. `planPursuit` takes a verdict from an
 * LLM and decides what it is allowed to cost. A verdict naming four material questions
 * still produces one Read; a verdict naming a question that was never a candidate produces
 * none. The model says what matters; this file says what that may spend.
 *
 * Run: npm run test:daily-plan
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  planDailyWork,
  planPursuit,
  isQuestionDue,
  MAX_PURSUITS_PER_DAY,
  MAX_TRIAGE_CANDIDATES,
  MAX_TRIAGE_CHANGES,
  QUESTION_DUE_DAYS,
  DAILY_BUDGET,
} from '../src/services/dailyPlan.js'
import { RUN_TIERS, resolveRunTier } from '../src/services/runTiers.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const planner = read('../src/services/dailyPlan.js')

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

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-14T06:00:00Z')

/** An open question that moved yesterday — i.e. NOT overdue. */
const q = (over = {}) => ({
  id: 'q1',
  question: 'Does Acme hold enterprise pricing flat?',
  watchFor: 'their /pricing page',
  status: 'open',
  origin: 'falsifier',
  sensitivity: 'medium',
  useful_count: 0,
  irrelevant_count: 0,
  pinned: false,
  opened_at: new Date(NOW - 3 * DAY).toISOString(),
  last_moved_at: new Date(NOW - 1 * DAY).toISOString(),
  last_checked_at: null,
  watchUrls: ['https://acme.com/pricing'],
  watchQueries: ['Acme enterprise pricing change'],
  ...over,
})

const change = (over = {}) => ({
  url: 'https://acme.com/pricing',
  entityName: 'Acme',
  sourceType: 'pricing',
  summary: 'Enterprise tier line removed',
  ...over,
})

// ─── 1. Purity ──────────────────────────────────────────────────────────────

check('the planner touches no network, database or clock of its own', () => {
  assert.ok(!/supabase|fetch\(|await /.test(planner),
    'routing must be testable without credentials, like connectorRegistry.js')
  assert.ok(!/Date\.now\(\)(?!\s*\})/.test(planner.replace(/now = Date\.now\(\)/g, '')),
    'the clock must arrive as an argument, or the tests cannot pin a date')
})

check('planning does not mutate the agenda it was given', () => {
  const agenda = [q()]
  const frozen = JSON.stringify(agenda)
  planDailyWork({ agenda, changes: [change()], now: NOW })
  assert.equal(JSON.stringify(agenda), frozen)
})

// ─── 2. Silence is the common case ──────────────────────────────────────────

check('nothing moved and nothing overdue → quiet, and it costs nothing', () => {
  const plan = planDailyWork({ agenda: [q()], changes: [], now: NOW })
  assert.equal(plan.action, 'quiet')
  assert.deepEqual(plan.candidates, [], 'a quiet day must not smuggle work through')
})

check('an empty agenda is quiet, not an error', () => {
  const plan = planDailyWork({ agenda: [], changes: [], now: NOW })
  assert.equal(plan.action, 'quiet')
  assert.match(plan.reason, /Nothing open/)
})

check('planning survives being handed nothing at all', () => {
  assert.equal(planDailyWork().action, 'quiet')
  assert.equal(planDailyWork({}).action, 'quiet')
})

check('the quiet reason is a sentence a founder could read, not a status code', () => {
  const plan = planDailyWork({ agenda: [q()], changes: [], now: NOW })
  assert.match(plan.reason, /^[A-Z].*\.$/,
    'daily_checks.note is rendered on the Desk — "NO_CHANGES" is not an answer')
  assert.ok(!/[_A-Z]{4,}/.test(plan.reason), 'no SCREAMING_CASE in founder-facing copy')
})

check('a changed page nothing was watching still gets judged, not dropped', () => {
  const plan = planDailyWork({
    agenda: [q()],
    changes: [change({ url: 'https://other.com/changelog' })],
    now: NOW,
  })
  assert.equal(plan.action, 'triage', 'the Agenda is not the only thing that can matter')
  assert.equal(plan.unmatchedChanges.length, 1)
})

// ─── 3. Due questions ───────────────────────────────────────────────────────

check('a question that has not moved in a week is due even with no page change', () => {
  const stale = q({ last_moved_at: new Date(NOW - (QUESTION_DUE_DAYS + 1) * DAY).toISOString() })
  assert.equal(isQuestionDue(stale, NOW), true)
  const plan = planDailyWork({ agenda: [stale], changes: [], now: NOW })
  assert.equal(plan.action, 'triage',
    'without this the loop can only react to pages, and a question answered by the news sits open forever')
})

check('a question with no movement recorded at all is due immediately', () => {
  assert.equal(isQuestionDue(q({ opened_at: null, last_moved_at: null }), NOW), true)
})

check('a closed question is never due, whatever its dates say', () => {
  for (const status of ['answered', 'retired', 'stale']) {
    assert.equal(isQuestionDue(q({ status, last_moved_at: null }), NOW), false)
  }
})

check('due-ness is measured from movement, never from being checked', () => {
  const checkedDailyNeverMoved = q({
    last_moved_at: new Date(NOW - 30 * DAY).toISOString(),
    last_checked_at: new Date(NOW - 1000).toISOString(),
  })
  assert.equal(isQuestionDue(checkedDailyNeverMoved, NOW), true,
    'looking at a question must not count as progress on it')
})

// ─── 4. Matching and ranking ────────────────────────────────────────────────

check('a changed page is attached to the question that was watching it', () => {
  const plan = planDailyWork({ agenda: [q()], changes: [change()], now: NOW })
  assert.equal(plan.action, 'triage')
  assert.equal(plan.candidates[0].questionId, 'q1')
  assert.equal(plan.candidates[0].changes.length, 1)
  assert.equal(plan.unmatchedChanges.length, 0)
})

check('URL matching survives protocol, www and trailing slash differences', () => {
  const plan = planDailyWork({
    agenda: [q({ watchUrls: ['http://www.acme.com/pricing/'] })],
    changes: [change({ url: 'https://acme.com/pricing' })],
    now: NOW,
  })
  assert.equal(plan.candidates[0].changes.length, 1,
    'a stored URL and a fetched URL differing only in scheme must not read as two pages')
})

check('a question whose page moved outranks one that is merely overdue', () => {
  const moved = q({ id: 'moved', sensitivity: 'low', origin: 'unknown' })
  const overdue = q({
    id: 'overdue', sensitivity: 'high', origin: 'founder',
    watchUrls: ['https://elsewhere.com/x'],
    last_moved_at: new Date(NOW - 30 * DAY).toISOString(),
  })
  const plan = planDailyWork({ agenda: [overdue, moved], changes: [change()], now: NOW })
  assert.equal(plan.candidates[0].questionId, 'moved',
    'a changed page is evidence; an overdue question is only a hunch')
})

check('the candidate list is capped so the triage call stays cheap', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    q({ id: `q${i}`, last_moved_at: new Date(NOW - 30 * DAY).toISOString() }))
  const plan = planDailyWork({ agenda: many, changes: [], now: NOW })
  assert.equal(plan.candidates.length, MAX_TRIAGE_CANDIDATES)
})

check('the cut falls at the bottom — ranking happens before truncation', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    q({ id: `q${i}`, pinned: false, last_moved_at: new Date(NOW - 30 * DAY).toISOString() }))
  many.push(q({ id: 'pinned', pinned: true, last_moved_at: new Date(NOW - 30 * DAY).toISOString() }))
  const plan = planDailyWork({ agenda: many, changes: [], now: NOW })
  assert.equal(plan.candidates[0].questionId, 'pinned',
    "truncating before ranking would silently drop the founder's own pin")
})

check('unmatched changes are capped too', () => {
  const changes = Array.from({ length: 30 }, (_, i) => change({ url: `https://x.com/${i}` }))
  const plan = planDailyWork({ agenda: [q()], changes, now: NOW })
  assert.equal(plan.unmatchedChanges.length, MAX_TRIAGE_CHANGES)
})

check('closed questions never become candidates', () => {
  const plan = planDailyWork({
    agenda: [q({ status: 'retired' }), q({ id: 'q2', status: 'answered' })],
    changes: [change()],
    now: NOW,
  })
  assert.ok(plan.candidates.every(c => c.questionId !== 'q1' && c.questionId !== 'q2'),
    'a retired question must not be pursued by the back door')
})

// ─── 5. The budget ──────────────────────────────────────────────────────────

check('the daily budget is about a tenth of a full run', () => {
  const full = read('../src/services/runTiers.js')
  const fullObs = Number(full.match(/full:[\s\S]*?maxObservations:\s*(\d+)/)[1])
  assert.ok(DAILY_BUDGET.maxObservations <= fullObs / 5,
    'cost scales with observations, not searches — this is the number that governs spend')
  assert.equal(DAILY_BUDGET.connectors, false, 'connectors are a weekly-sweep concern')
  assert.equal(DAILY_BUDGET.sourceWatch, true, 'the watch IS the daily loop')
})

check('the budget object is frozen — a step must not be able to raise its own ceiling', () => {
  assert.throws(() => { 'use strict'; DAILY_BUDGET.maxQueries = 99 })
})

check('EVERY budget resolves to itself, not to full', () => {
  // The bug this pins cost a seven-fold overspend on a timer, silently.
  //
  // `configureIntelligenceRuntime({ budget })` does `resolveRunTier(budget.name || budget)`,
  // and `resolveRunTier` falls back to `full` for any name not in RUN_TIERS. DAILY_BUDGET
  // was originally its own object in dailyPlan.js with name 'daily' — unregistered — so
  // every daily pursuit ran at 22 queries and 200 observations instead of 4 and 30. Nothing
  // threw; the only symptom was the bill.
  //
  // Asserted over the whole registry rather than just `daily`, because the next budget
  // someone adds will be added the same way.
  for (const [key, tier] of Object.entries(RUN_TIERS)) {
    assert.equal(tier.name, key,
      `RUN_TIERS.${key} calls itself "${tier.name}" — resolution is by name, so it would ` +
      `resolve to full`)
    assert.equal(resolveRunTier(tier.name).name, key,
      `passing RUN_TIERS.${key} to configureIntelligenceRuntime silently yields ` +
      `"${resolveRunTier(tier.name).name}"`)
    assert.ok(Object.isFrozen(tier), `RUN_TIERS.${key} is mutable — a ceiling that can be raised is not one`)
  }
})

check('DAILY_BUDGET is the registered tier, not a copy of it', () => {
  assert.equal(DAILY_BUDGET, RUN_TIERS.daily,
    'two definitions of the same budget drift, and the one that loses is whichever the ' +
    'resolver does not consult')
})

check('query floors never over-subscribe their own budget', () => {
  // Re-derived per tier rather than scaled — the full-tier floors reused at 8 queries would
  // eat the entire budget twice over, and the run would say nothing about the question the
  // founder actually asked.
  for (const [key, t] of Object.entries(RUN_TIERS)) {
    const floors = (t.inquiryQueryFloor || 0) + (t.tierQueryFloor || 0) + (t.docQueryFloor || 0) + (t.demandQueryFloor || 0)
    assert.ok(floors <= t.maxQueries,
      `${key}: floors sum to ${floors} against a budget of ${t.maxQueries}`)
  }
})

// ─── 6. The guard rail on the model ─────────────────────────────────────────

const CANDIDATES = [
  { questionId: 'a', question: 'A?', watchQueries: ['a query'], changes: [change()] },
  { questionId: 'b', question: 'B?', watchQueries: ['b query'], changes: [] },
]

check('no material findings → no pursuit, and that is recorded as an outcome', () => {
  const out = planPursuit({ material: [], summary: 'Nothing here changes the read.' }, CANDIDATES)
  assert.equal(out.pursue, false)
  assert.equal(out.reason, 'Nothing here changes the read.',
    "the model's own words for a quiet day are worth keeping")
})

check('a malformed or empty verdict is silence, not a crash', () => {
  for (const v of [null, undefined, {}, { material: 'nope' }, { material: null }]) {
    assert.equal(planPursuit(v, CANDIDATES).pursue, false)
  }
})

check('the model cannot invent a question that was never a candidate', () => {
  const out = planPursuit({ material: [{ question_id: 'ghost', why: 'trust me' }] }, CANDIDATES)
  assert.equal(out.pursue, false,
    'a hallucinated id must produce no work at all, not a search against nothing')
})

check('four material questions still produce exactly one pursuit', () => {
  const many = Array.from({ length: 4 }, (_, i) =>
    ({ questionId: `q${i}`, question: '?', watchQueries: [`query ${i}`], changes: [] }))
  const out = planPursuit({ material: many.map(c => ({ question_id: c.questionId, why: 'x' })) }, many)
  assert.equal(out.pursue, true)
  assert.equal(out.questionId, 'q0', 'the candidate ranking decides, not the model ordering')
  assert.equal(MAX_PURSUITS_PER_DAY, 1,
    'a loop that can emit five items in a morning has recreated the problem it was built to fix')
})

check('the candidate ranking outranks the order the model listed them in', () => {
  const out = planPursuit({
    material: [{ question_id: 'b', why: 'b first' }, { question_id: 'a', why: 'a second' }],
  }, CANDIDATES)
  assert.equal(out.questionId, 'a',
    "candidates arrive ranked by the founder's pins and sensitivities; the model must not reorder that")
})

check("the question's own stored queries come before the model's proposals", () => {
  const out = planPursuit({
    material: [{ question_id: 'a', why: 'x', queries: ['model idea'] }],
  }, CANDIDATES)
  assert.equal(out.queries[0], 'a query',
    'watch_queries were written when the question was framed, with the whole brief in view')
  assert.ok(out.queries.includes('model idea'))
})

check('queries are deduped and capped at the daily budget', () => {
  const out = planPursuit({
    material: [{ question_id: 'a', why: 'x', queries: ['a query', 'a query', 'q2', 'q3', 'q4', 'q5', 'q6'] }],
  }, CANDIDATES)
  assert.ok(out.queries.length <= DAILY_BUDGET.maxQueries)
  assert.equal(new Set(out.queries).size, out.queries.length)
})

check('an empty or quote-only query is dropped, never issued', () => {
  const out = planPursuit({
    material: [{ question_id: 'b', why: 'x', queries: ['', '   ', '""', "''"] }],
  }, [{ questionId: 'b', question: 'B?', watchQueries: [], changes: [] }])
  assert.equal(out.pursue, false,
    'a template whose variable never resolved emitted `"" review complaints 2026` and ' +
    'Tavily answered it with whatever it liked — those must drop, not fire')
})

check('material but unsearchable is silence with a reason, not a wasted run', () => {
  const out = planPursuit(
    { material: [{ question_id: 'b', why: 'matters' }] },
    [{ questionId: 'b', question: 'B?', watchQueries: [], changes: [] }],
  )
  assert.equal(out.pursue, false)
  assert.match(out.reason, /no search/i)
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
