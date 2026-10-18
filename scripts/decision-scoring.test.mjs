/**
 * The arithmetic of a weighed decision.
 *
 * Everything here is checkable by hand, which is the point — this is the part of a decision
 * brief a founder can take into a board meeting and defend. If the weighing were a model's
 * opinion, the only available disagreement would be "I don't think so".
 *
 * The load-bearing test is `the tipping point actually tips`: for every criterion the
 * sensitivity calls decisive, re-running the whole weighing AT that weight must genuinely
 * reverse the result. A plausible-looking number that does not do what the sentence claims
 * would be worse than omitting it — the founder would defend a threshold that is not real.
 *
 * Run: npm run test:scoring
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  normaliseWeights,
  scoreOptions,
  sensitivity,
  describeLeaning,
  SCORE_MAX,
  TOO_CLOSE_MARGIN,
} from '../src/services/decisionScoring.js'
import { ADVICE_PHRASES } from '../src/services/briefSchema.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const source = read('../src/services/decisionScoring.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const OPTIONS = [{ id: 'a', label: 'Enterprise motion' }, { id: 'b', label: 'Self-serve motion' }]
const CRITERIA = [
  { id: 'speed', name: 'Speed to revenue', weight: 0.5 },
  { id: 'cost', name: 'Onboarding cost', weight: 0.3 },
  { id: 'moat', name: 'Defensibility', weight: 0.2 },
]
const SCORES = [
  { option_id: 'a', criterion_id: 'speed', score: 2 },
  { option_id: 'a', criterion_id: 'cost', score: 2 },
  { option_id: 'a', criterion_id: 'moat', score: 5 },
  { option_id: 'b', criterion_id: 'speed', score: 4 },
  { option_id: 'b', criterion_id: 'cost', score: 4 },
  { option_id: 'b', criterion_id: 'moat', score: 1 },
]
const run = (criteria = CRITERIA, scores = SCORES) =>
  scoreOptions({ criteria, scores, options: OPTIONS })

// ─── Determinism ────────────────────────────────────────────────────────────

check('the weighing is arithmetic, not a model call', () => {
  assert.ok(!/callLLM|postJson|fetch\(|await |PROMPTS/.test(source),
    'a founder must be able to disagree with a score or a weight and watch the answer move; ' +
    'that is impossible if the answer came from a sentence a model wrote')
})

check('weights normalise, however they arrive', () => {
  const w = normaliseWeights([{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }])
  assert.equal(w[0].weight, 0.75)
  assert.equal(w[1].weight, 0.25)
  assert.ok(w.every(x => x.weightWasSupplied))
})

check('no usable weights means equal weights, and it says so', () => {
  const w = normaliseWeights([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  assert.ok(w.every(x => Math.abs(x.weight - 1 / 3) < 1e-9))
  assert.ok(w.every(x => x.weightWasSupplied === false),
    '"we weighed everything equally" is a choice the reader should be able to see and reject')
  assert.deepEqual(normaliseWeights([]), [])
  assert.deepEqual(normaliseWeights(null), [])
})

// ─── Hand-checkable ─────────────────────────────────────────────────────────

check('the totals are what you get doing it by hand', () => {
  const r = run()
  // a: .5(2/5) + .3(2/5) + .2(5/5) = .2 + .12 + .2 = .52
  // b: .5(4/5) + .3(4/5) + .2(1/5) = .4 + .24 + .04 = .68
  const a = r.totals.find(t => t.optionId === 'a')
  const b = r.totals.find(t => t.optionId === 'b')
  assert.ok(Math.abs(a.total - 0.52) < 1e-9, `a=${a.total}`)
  assert.ok(Math.abs(b.total - 0.68) < 1e-9, `b=${b.total}`)
  assert.equal(r.leader.optionId, 'b')
  assert.ok(Math.abs(r.margin - 0.16) < 1e-9)
})

check('scores are clamped, and junk is ignored rather than guessed at', () => {
  const r = scoreOptions({
    criteria: [{ id: 'x', name: 'X', weight: 1 }],
    scores: [{ option_id: 'a', criterion_id: 'x', score: 99 }, { option_id: 'b', criterion_id: 'x', score: 'nonsense' }],
    options: OPTIONS,
  })
  assert.equal(r.totals.find(t => t.optionId === 'a').total, 1, 'above the scale clamps to the top')
  assert.deepEqual(r.totals.find(t => t.optionId === 'b').gaps, ['x'], 'unparseable is a gap, not a zero')
})

// ─── A gap is not a zero ────────────────────────────────────────────────────

check('an unscored criterion is a gap, never counted as a bad score', () => {
  // Zero means "this option is bad at this" — a claim. Missing means "we did not find out".
  // Conflating them invents evidence against whichever option was researched least.
  const partial = SCORES.filter(s => !(s.option_id === 'a' && s.criterion_id === 'cost'))
  const r = run(CRITERIA, partial)
  const a = r.totals.find(t => t.optionId === 'a')
  assert.deepEqual(a.gaps, ['cost'])
  // Re-based on the .7 of weight actually covered: (.2 + .2)/.7 ≈ .5714 — better than the
  // .4 a zero would have produced, and correctly so.
  assert.ok(Math.abs(a.total - 0.4 / 0.7) < 1e-9, `got ${a.total}`)
  assert.ok(Math.abs(a.coverage - 0.7) < 1e-9)
  assert.equal(r.unscored, 1)
})

check('an option with no scores at all does not silently win', () => {
  const r = scoreOptions({ criteria: CRITERIA, scores: [], options: OPTIONS })
  assert.ok(r.totals.every(t => t.total === 0 && t.coverage === 0))
  assert.equal(r.unscored, 6)
})

// ─── The load-bearing test ──────────────────────────────────────────────────

check('the tipping point actually tips', () => {
  const r = run()
  const sens = sensitivity({ criteria: CRITERIA, totals: r.totals, scores: SCORES, leader: r.leader, runnerUp: r.runnerUp })

  const decisive = sens.filter(s => s.decisive)
  assert.ok(decisive.length > 0, 'expected at least one criterion that can flip this')

  for (const s of decisive) {
    // Rebuild the weights exactly as the formula claims: this criterion at its tipping
    // weight, the others re-proportioned to fill what remains.
    const others = CRITERIA.filter(c => c.id !== s.criterionId)
    const otherTotal = others.reduce((t, c) => t + c.weight, 0)
    const rebuilt = CRITERIA.map(c => c.id === s.criterionId
      ? { ...c, weight: s.tippingWeight }
      : { ...c, weight: (c.weight / otherTotal) * (1 - s.tippingWeight) })

    const atTip = run(rebuilt)
    assert.ok(Math.abs(atTip.margin) < 1e-6,
      `${s.name}: at the stated tipping weight of ${s.tippingWeight} the margin should be ~0, got ${atTip.margin}`)

    // And just past it, the leader must actually change — otherwise the sentence promises
    // a threshold that is not one.
    const past = s.direction === 'up' ? Math.min(0.999, s.tippingWeight + 0.02) : Math.max(0.001, s.tippingWeight - 0.02)
    const pastOthers = CRITERIA.map(c => c.id === s.criterionId
      ? { ...c, weight: past }
      : { ...c, weight: (c.weight / otherTotal) * (1 - past) })
    assert.notEqual(run(pastOthers).leader.optionId, r.leader.optionId,
      `${s.name}: crossing the tipping weight did not change the answer`)
  }
})

check('a criterion that cannot change the answer is reported as such', () => {
  // Both options identical on 'moat' — no weight on it can move anything.
  const flat = SCORES.map(s => s.criterion_id === 'moat' ? { ...s, score: 3 } : s)
  const r = run(CRITERIA, flat)
  const sens = sensitivity({ criteria: CRITERIA, totals: r.totals, scores: flat, leader: r.leader, runnerUp: r.runnerUp })
  const moat = sens.find(s => s.criterionId === 'moat')
  assert.equal(moat.decisive, false)
  assert.equal(moat.tippingWeight, null,
    'often the most useful line in the brief: the argument about this one does not matter')
})

check('the nearest tipping point is listed first', () => {
  const r = run()
  const sens = sensitivity({ criteria: CRITERIA, totals: r.totals, scores: SCORES, leader: r.leader, runnerUp: r.runnerUp })
  const decisive = sens.filter(s => s.decisive)
  for (let i = 1; i < decisive.length; i++) {
    const prev = Math.abs(decisive[i - 1].tippingWeight - decisive[i - 1].weight)
    const cur = Math.abs(decisive[i].tippingWeight - decisive[i].weight)
    assert.ok(prev <= cur + 1e-9, 'the criterion a small change of mind would flip comes first')
  }
  assert.ok(sens.filter(s => !s.decisive).every((_, i, arr) => true))
})

check('sensitivity is silent when there is nothing to compare', () => {
  assert.deepEqual(sensitivity({ criteria: CRITERIA, scores: SCORES, leader: null, runnerUp: null }), [])
  const one = scoreOptions({ criteria: CRITERIA, scores: SCORES, options: [OPTIONS[0]] })
  assert.deepEqual(sensitivity({ ...one, scores: SCORES }), [])
})

// ─── The sentence ───────────────────────────────────────────────────────────

check('the conclusion names what the evidence favours, and the threshold', () => {
  const r = run()
  const sens = sensitivity({ criteria: CRITERIA, totals: r.totals, scores: SCORES, leader: r.leader, runnerUp: r.runnerUp })
  const out = describeLeaning(r, sens)
  assert.match(out.text, /the evidence favours Self-serve motion over Enterprise motion/)
  assert.match(out.text, /\d+%/)
  assert.match(out.text, /stops holding if you weight/,
    'the threshold is what makes this defensible rather than merely confident')
})

check('the conclusion is a judgment, not advice', () => {
  const r = run()
  const sens = sensitivity({ criteria: CRITERIA, totals: r.totals, scores: SCORES, leader: r.leader, runnerUp: r.runnerUp })
  for (const out of [describeLeaning(r, sens), describeLeaning(r, []), describeLeaning({ ...r, tooClose: true }, sens)]) {
    const lower = out.text.toLowerCase()
    for (const phrase of ADVICE_PHRASES) {
      assert.ok(!lower.includes(phrase), `the one sentence the product is judged on contains "${phrase}"`)
    }
    // THE TEST from the prompt rules: still true if the founder chooses the other way.
    assert.ok(/the evidence/i.test(out.text) || /does not separate/i.test(out.text),
      'it must describe the evidence, not instruct the reader')
  }
})

check('two options the criteria do not separate are reported as such', () => {
  const even = [
    { option_id: 'a', criterion_id: 'speed', score: 3 }, { option_id: 'b', criterion_id: 'speed', score: 3 },
    { option_id: 'a', criterion_id: 'cost', score: 3 }, { option_id: 'b', criterion_id: 'cost', score: 3 },
    { option_id: 'a', criterion_id: 'moat', score: 3 }, { option_id: 'b', criterion_id: 'moat', score: 3 },
  ]
  const r = run(CRITERIA, even)
  assert.equal(r.tooClose, true)
  assert.ok(r.margin < TOO_CLOSE_MARGIN)
  const out = describeLeaning(r, [])
  assert.match(out.text, /does not separate them/,
    'a fabricated winner is worse than admitting the criteria do not decide it')
  assert.equal(out.decisive, false)
})

check('no leader, no sentence', () => {
  assert.equal(describeLeaning({ leader: null }), null)
  assert.equal(describeLeaning(null), null)
})

check('nothing is mutated', () => {
  const c = JSON.stringify(CRITERIA), s = JSON.stringify(SCORES)
  const r = run()
  sensitivity({ criteria: CRITERIA, totals: r.totals, scores: SCORES, leader: r.leader, runnerUp: r.runnerUp })
  assert.equal(JSON.stringify(CRITERIA), c)
  assert.equal(JSON.stringify(SCORES), s)
})

check('the scale is narrow on purpose', () => {
  assert.equal(SCORE_MAX, 5, 'a wider scale implies a precision the evidence does not have')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
