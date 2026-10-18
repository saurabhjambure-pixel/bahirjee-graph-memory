/**
 * The decision brief — assembly, confidence, and the loop-closer.
 *
 * Three things this file exists to stop, all of them silent:
 *
 *   1. A CONFIDENT READ OVER HALF A GRID. Sources measure how much was read; coverage
 *      measures how much of the actual question was answered. The gaps are never randomly
 *      placed — they sit wherever the evidence was hardest to find, which is usually the
 *      thing that matters. A decision weighed on 40% of its cells must not report High.
 *
 *   2. THE MODEL RE-WEIGHTING WHAT THE FOUNDER SET. Weights are the founder's half of the
 *      analysis. A model quietly adjusting them answers a different question from the one
 *      asked, and nothing in the output would show it happened.
 *
 *   3. AN AGENDA BURIED IN ASSUMPTIONS. Harvesting every claim a decision rested on would
 *      fill a six-item surface with noise. Only the load-bearing ones — the scores on
 *      criteria the sensitivity proved decisive — are worth months of watching.
 *
 * Run: npm run test:decision-brief
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DECISION_SCHEMA,
  coverageOf,
  capForCoverage,
  buildDecisionBrief,
  auditDecisionVoice,
  harvestDecisionAssumptions,
} from '../src/services/decisionBrief.js'
import { routeFramework } from '../src/services/decisionFrameworks.js'
import { ADVICE_PHRASES } from '../src/services/briefSchema.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const source = read('../src/services/decisionBrief.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const FRAME = {
  id: 'dec-1',
  decision_statement: 'Enterprise motion or self-serve?',
  options: [{ id: 'ent', label: 'Enterprise motion' }, { id: 'ss', label: 'Self-serve motion' }],
}
const ROUTING = routeFramework(FRAME, { exclusive: true, reversibility: 'easy', worst_case: 'survivable', delay_cost: 'none' })
const RAW = {
  criteria: [
    { id: 'speed', name: 'Speed to revenue', weight: 0.5, why: 'you said the Q4 target is the constraint' },
    { id: 'moat', name: 'Defensibility', weight: 0.5, why: 'you named lock-in as the bet' },
  ],
  scores: [
    { option_id: 'ent', criterion_id: 'speed', score: 2, basis: 'Their enterprise cycle ran 9 months.', evidence_refs: [1] },
    { option_id: 'ss', criterion_id: 'speed', score: 4, basis: 'Self-serve peers convert in under a week.', evidence_refs: [2] },
    { option_id: 'ent', criterion_id: 'moat', score: 5, basis: 'Integration depth makes switching costly.', evidence_refs: [3] },
    { option_id: 'ss', criterion_id: 'moat', score: 1, basis: 'Nothing stops a self-serve user leaving.', evidence_refs: [] },
  ],
  unknowns: [
    { text: 'Whether mid-market churn stays under 4%', would_settle_it: 'their next published retention figure' },
    { text: 'Something nobody can check' },
  ],
}
const SIGNALS = Array.from({ length: 14 }, (_, i) => ({
  source_url: `https://d${i % 7}.com/a${i}`, source_class: ['news', 'filing', 'review'][i % 3],
}))
const build = (over = {}) =>
  buildDecisionBrief({ raw: RAW, frame: FRAME, routing: ROUTING, signals: SIGNALS, depth: 'full', ...over })

// ─── Shape ──────────────────────────────────────────────────────────────────

check('a brief carries its schema, its lens, and why that lens', () => {
  const b = build()
  assert.equal(b.schema, DECISION_SCHEMA)
  assert.equal(b.framework.id, 'mcda')
  assert.ok(b.framework.why.length > 20)
  assert.ok(b.framework.what_would_change_it.length > 20,
    'a founder must be able to argue with the method, not only the conclusion')
})

check('the conclusion is assembled in code, never taken from the model', () => {
  // The single sentence the product is judged on. A model-written one could drift into
  // advice on any bad generation; an assembled one cannot.
  assert.match(source, /describeLeaning/)
  const withClaim = build({ raw: { ...RAW, leaning: 'You should pick enterprise.', recommendation: 'enterprise' } })
  assert.ok(!/should/i.test(withClaim.leaning.text),
    'a model-supplied conclusion must be ignored entirely, not merged')
  assert.match(withClaim.leaning.text, /the evidence favours/i)
})

check('a score with no basis is dropped, not rendered bare', () => {
  const b = build({ raw: { ...RAW, scores: [...RAW.scores, { option_id: 'ent', criterion_id: 'speed', score: 5 }] } })
  assert.ok(b.scores.every(s => s.basis),
    'an unexplained number the founder is asked to argue with is worse than a visible gap')
})

// ─── The founder's weights win ──────────────────────────────────────────────

check('founder weights override the model entirely', () => {
  const mine = [{ id: 'speed', name: 'Speed to revenue', weight: 0.9 }, { id: 'moat', name: 'Defensibility', weight: 0.1 }]
  const b = build({ founderCriteria: mine })
  const speed = b.criteria.find(c => c.id === 'speed')
  assert.ok(Math.abs(speed.weight - 0.9) < 1e-9,
    'a model re-weighting what a person just set answers a different question, invisibly')
  assert.equal(b.totals[0].optionId, 'ss', 'and the answer must actually follow the weights')
})

check('the same evidence with different weights gives a different answer', () => {
  const speedFirst = build({ founderCriteria: [{ id: 'speed', weight: 0.9 }, { id: 'moat', weight: 0.1 }] })
  const moatFirst = build({ founderCriteria: [{ id: 'speed', weight: 0.1 }, { id: 'moat', weight: 0.9 }] })
  assert.notEqual(speedFirst.totals[0].optionId, moatFirst.totals[0].optionId,
    'if weights did not move the conclusion, asking for them would be theatre')
})

// ─── Coverage ───────────────────────────────────────────────────────────────

check('coverage counts the grid actually filled', () => {
  assert.deepEqual(coverageOf({ options: FRAME.options, criteria: RAW.criteria, scores: RAW.scores }),
    { scored: 4, possible: 4, ratio: 1 })
  assert.deepEqual(coverageOf({ options: FRAME.options, criteria: RAW.criteria, scores: RAW.scores.slice(0, 2) }),
    { scored: 2, possible: 4, ratio: 0.5 })
  assert.equal(coverageOf({}).ratio, 0, 'an empty grid must not divide by zero')
})

check('half a grid cannot be High confidence, whatever the sources say', () => {
  const full = build()
  assert.equal(full.confidence.coverage.ratio, 1)

  const thin = build({ raw: { ...RAW, scores: RAW.scores.slice(0, 2) } })
  assert.equal(thin.confidence.level, 'Low')
  assert.ok(thin.confidence.capped_by.includes('score_coverage'))
  assert.match(thin.confidence.basis, /could not be scored/,
    'the cap must name itself, or the level is asserted rather than auditable')
})

check('the cap only ever lowers', () => {
  const low = { level: 'Low', basis: 'thin.', capped_by: [] }
  assert.equal(capForCoverage(low, { ratio: 1, scored: 4, possible: 4 }).level, 'Low',
    'full coverage must not promote a read that was thin for other reasons')
  const high = { level: 'High', basis: 'strong.', capped_by: [] }
  assert.equal(capForCoverage(high, { ratio: 0.8, scored: 8, possible: 10 }).level, 'Medium')
  assert.equal(capForCoverage(high, { ratio: 0.5, scored: 5, possible: 10 }).level, 'Low')
})

check('confidence reuses the weekly brief\'s calibration, not a second scale', () => {
  assert.match(source, /calibrateConfidence/,
    'two answers to "how sure are we?" drift, and the disagreement is invisible until the ' +
    'same evidence is rated differently in two places')
  const b = build()
  for (const f of ['evidence_count', 'unique_domains', 'depth', 'basis', 'level']) {
    assert.ok(f in b.confidence, `confidence is missing ${f}`)
  }
})

check('a shallow run still cannot claim High', () => {
  assert.notEqual(build({ depth: 'shallow' }).confidence.level, 'High',
    'uncertainty is the paywall — that has to hold for decisions too')
})

// ─── The advice guard ───────────────────────────────────────────────────────

check('the guard reads every field the model wrote', () => {
  const b = build({
    raw: {
      ...RAW,
      scores: RAW.scores.map((s, i) => i === 0 ? { ...s, basis: 'You should move faster here.' } : s),
      unknowns: [{ text: 'We recommend checking churn', would_settle_it: 'their filing' }],
    },
  })
  const hits = auditDecisionVoice(b)
  assert.ok(hits.some(h => h.where.startsWith('scores[')), 'a per-cell basis is founder-facing prose')
  assert.ok(hits.some(h => h.where.startsWith('unknowns[')))
})

check('a clean brief trips nothing', () => {
  assert.deepEqual(auditDecisionVoice(build()), [])
})

check('the assembled conclusion is itself audited', () => {
  // Not redundant: it is how a future edit to describeLeaning that introduces an imperative
  // gets caught by the same net as a bad generation.
  assert.match(source, /look\('leaning'/)
  const b = build()
  const lower = b.leaning.text.toLowerCase()
  for (const p of ADVICE_PHRASES) assert.ok(!lower.includes(p))
})

check('the guard detects, it does not rewrite', () => {
  const bad = 'You should move faster here.'
  const b = build({ raw: { ...RAW, scores: RAW.scores.map((s, i) => i === 0 ? { ...s, basis: bad } : s) } })
  assert.equal(b.scores[0].basis, bad,
    'editing the words to hide the leak removes the only evidence the prompt started giving advice')
})

// ─── The loop-closer ────────────────────────────────────────────────────────

check('only the assumptions that could change the answer become watch items', () => {
  const b = build()
  const out = harvestDecisionAssumptions(b)
  assert.ok(out.length > 0)
  assert.ok(out.every(q => q.origin === 'decision'))
  assert.ok(out.every(q => q.originRef === 'dec-1'), 'a watch item must point back at its decision')

  // Every harvested score-assumption belongs to the LEADING option on a DECISIVE criterion.
  const leader = b.totals[0].optionId
  const decisive = new Set(b.sensitivity.filter(s => s.decisive).map(s => s.criterionId))
  const fromScores = b.scores.filter(s => out.some(o => o.question.includes(s.basis)))
  for (const s of fromScores) {
    assert.equal(s.option_id, leader)
    assert.ok(decisive.has(s.criterion_id),
      'watching a criterion the sensitivity proved cannot flip the result wastes months of attention')
  }
})

check('an unknown with no route to an answer is not watched', () => {
  const out = harvestDecisionAssumptions(build())
  assert.ok(out.some(q => q.question.includes('mid-market churn')), 'this one names what would settle it')
  assert.ok(!out.some(q => q.question.includes('Something nobody can check')),
    'an unknown with no way to resolve it would sit open forever')
})

check('the harvest is bounded and deduped', () => {
  const out = harvestDecisionAssumptions(build())
  assert.ok(out.length <= 5, 'the Agenda shows six items; one decision must not fill it')
  assert.equal(new Set(out.map(q => q.question)).size, out.length)
})

check('the harvest is pure and survives a thin brief', () => {
  const fn = source.slice(source.indexOf('export function harvestDecisionAssumptions'))
  assert.ok(!/supabase|await /.test(fn), 'the caller decides when to write')
  assert.deepEqual(harvestDecisionAssumptions({}), [])
  assert.deepEqual(harvestDecisionAssumptions(null), [])
})

check('harvested items fit what the Agenda accepts', () => {
  // openQuestion refuses an origin outside AGENDA_ORIGINS, logging and returning null — so
  // a mismatch here would silently produce no watch items at all. Exactly the v25 shape.
  const agenda = read('../src/services/agendaService.js')
  const origins = agenda.match(/AGENDA_ORIGINS = \[([^\]]*)\]/)[1]
  assert.ok(origins.includes("'decision'"),
    'the Agenda must accept origin "decision", or the loop-closer writes nothing and says nothing')
})

// ─── Non-MCDA lenses ────────────────────────────────────────────────────────

check('a non-weighing lens produces its own conclusion, and no scorecard', () => {
  const oneOption = { ...FRAME, options: [FRAME.options[0]] }
  const wrapRouting = routeFramework(oneOption, { reversibility: 'easy', worst_case: 'survivable', delay_cost: 'none' })
  const b = buildDecisionBrief({
    raw: { lens: { unnamed_options: [{ label: 'Partner-led', why: 'reaches the same buyer without the build' }], reality_tests: [{ option: 'Partner-led', test: 'one pilot with an existing integrator', cost: 'two weeks' }] } },
    frame: oneOption, routing: wrapRouting, signals: SIGNALS,
  })
  assert.equal(b.framework.id, 'wrap')
  // A scorecard would be meaningless here, but silence would be worse: the lens ran and
  // reached something, and the founder should be told what.
  assert.deepEqual(b.totals, [], 'nothing to rank')
  assert.deepEqual(b.sensitivity, [], 'nothing to tip')
  assert.ok(b.lens, 'the lens block carries the substance')
  assert.ok(b.leaning?.text?.length > 20, 'and the lens still reaches a conclusion')
  assert.match(b.leaning.text, /other/i)
})

check('a route to MCDA without a weighing\'s inputs does not fake a scorecard', () => {
  const b = buildDecisionBrief({ raw: { criteria: [], scores: [] }, frame: FRAME, routing: ROUTING, signals: SIGNALS })
  assert.deepEqual(b.totals, [], 'an empty scorecard reads as "we compared them and it was close"')
  assert.equal(b.leaning, null, 'nothing was compared, so nothing is claimed')
})

check('every lens reaches a conclusion assembled in code', () => {
  const lensesSource = read('../src/services/decisionLenses.js')
  assert.ok(!/callLLM|postJson|PROMPTS|await /.test(lensesSource),
    'the conclusion is the line a founder repeats to someone else; a model writing it would ' +
    'eventually write an instruction, and the guard only detects after the fact')

  const cases = [
    ['wrap', { unnamed_options: [{ label: 'X' }], reality_tests: [{ test: 'a pilot', cost: 'a week' }] }, 1],
    ['regret', { unrecoverable: [{ option: 'Enterprise motion', what: 'the contracts run three years' }] }, 2],
    ['eisenhower', { compounds: [{ label: 'A' }], buys_time: [{ label: 'B' }] }, 2],
    ['satisficing', { bar: 'a paying pilot by March', clears_bar: [{ option: 'Self-serve motion' }] }, 2],
  ]
  for (const [id, lensRaw, optionCount] of cases) {
    const routing = { framework: { id, name: id, formal: id }, why: 'because', whatWouldChangeIt: 'something', answered: [] }
    const b = buildDecisionBrief({
      raw: { lens: lensRaw },
      frame: { ...FRAME, options: FRAME.options.slice(0, optionCount) },
      routing, signals: SIGNALS,
    })
    assert.ok(b.leaning?.text, `${id} reached no conclusion`)
    const lower = b.leaning.text.toLowerCase()
    for (const phrase of ADVICE_PHRASES) {
      assert.ok(!lower.includes(phrase), `${id}'s conclusion contains "${phrase}"`)
    }
    assert.deepEqual(auditDecisionVoice(b), [], `${id} leaked advice somewhere in its block`)
  }
})

check('a lens that found nothing says so instead of padding', () => {
  const routing = { framework: { id: 'regret', name: 'r', formal: 'r' }, why: 'w', whatWouldChangeIt: 'x', answered: [] }
  const b = buildDecisionBrief({ raw: { lens: { unrecoverable: [] } }, frame: FRAME, routing, signals: SIGNALS })
  assert.equal(b.leaning.decisive, false)
  assert.match(b.leaning.text, /Nothing here turned out to be unrecoverable/)
})

check('WRAP\'s tripwire and regret\'s irreversible parts become watch items', () => {
  const wrapRouting = { framework: { id: 'wrap', name: 'w', formal: 'w' }, why: 'w', whatWouldChangeIt: 'x', answered: [] }
  const wrap = buildDecisionBrief({
    raw: { lens: { unnamed_options: [{ label: 'X' }], tripwire: { condition: 'onboarding takes over six weeks', then: 'the self-serve case weakens' } } },
    frame: FRAME, routing: wrapRouting, signals: SIGNALS,
  })
  const out = harvestDecisionAssumptions(wrap)
  assert.ok(out.some(q => /onboarding takes over six weeks/.test(q.question)),
    'a tripwire is the purest watch item in the product — a condition set in advance, while ' +
    'it could still be judged honestly')

  const regretRouting = { framework: { id: 'regret', name: 'r', formal: 'r' }, why: 'w', whatWouldChangeIt: 'x', answered: [] }
  const regret = buildDecisionBrief({
    raw: { lens: { unrecoverable: [{ option: 'Enterprise motion', what: 'the contracts run three years' }] } },
    frame: FRAME, routing: regretRouting, signals: SIGNALS,
  })
  assert.ok(harvestDecisionAssumptions(regret).some(q => /contracts run three years/.test(q.question)))
})

check('sequencing and good-enough calls open no standing questions', () => {
  for (const id of ['eisenhower', 'satisficing']) {
    const routing = { framework: { id, name: id, formal: id }, why: 'w', whatWouldChangeIt: 'x', answered: [] }
    const b = buildDecisionBrief({
      raw: { lens: { compounds: [{ label: 'A' }], buys_time: [{ label: 'B' }], bar: 'a pilot', clears_bar: [{ option: 'X' }] } },
      frame: FRAME, routing, signals: SIGNALS,
    })
    assert.deepEqual(harvestDecisionAssumptions(b), [],
      `${id}: a sequencing or good-enough call is re-made when circumstances change, not ` +
      'monitored between times — watch items here would fill the Agenda with things nobody acts on')
  }
})

check('a brief survives being handed almost nothing', () => {
  const b = buildDecisionBrief({})
  assert.equal(b.schema, DECISION_SCHEMA)
  assert.equal(b.leaning, null)
  assert.ok(b.confidence)
  assert.deepEqual(auditDecisionVoice(b), [])
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
