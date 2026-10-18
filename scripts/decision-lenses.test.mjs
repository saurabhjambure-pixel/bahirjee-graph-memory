/**
 * The four lenses that are not a weighing.
 *
 * MCDA has arithmetic to keep it honest — you can check a weighted sum. These four have
 * only prose, which makes them the easiest place in the product for advice to creep back
 * in, and the hardest place to notice when it does.
 *
 * So the same rule applies with no arithmetic to lean on: the CONCLUSION IS ASSEMBLED IN
 * CODE. The model supplies substance — which options were not named, what cannot be walked
 * back — and every one of those strings is founder-facing prose that the advice guard must
 * be able to find. `lensProse` is what tells the guard where to look, and a field it forgets
 * is a field nothing checks.
 *
 * Run: npm run test:lenses
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normaliseLens, describeLens, lensProse, harvestLensAssumptions } from '../src/services/decisionLenses.js'
import { ADVICE_PHRASES } from '../src/services/briefSchema.js'
import { FRAMEWORK_IDS } from '../src/services/decisionFrameworks.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const source = read('../src/services/decisionLenses.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const FRAME = { id: 'd1', options: [{ id: 'a', label: 'Build it' }, { id: 'b', label: 'Partner' }] }
const LENSES = ['wrap', 'regret', 'eisenhower', 'satisficing']

const FIXTURES = {
  wrap: {
    unnamed_options: [{ label: 'Partner-led', why: 'reaches the same buyer without the build' }, { label: 'White-label', why: 'others in the category did this first' }],
    reality_tests: [{ option: 'Partner-led', test: 'one pilot with an existing integrator', cost: 'two weeks' }],
    outside_view: 'Companies that built this in-house took nine months longer than they planned.',
    tripwire: { condition: 'onboarding still takes over six weeks in March', then: 'the build case weakens sharply' },
  },
  regret: {
    asymmetry: 'The upside is a better margin; the downside is three years of contracts you cannot exit.',
    unrecoverable: [{ option: 'Build it', what: 'the hiring commitment runs past your runway' }],
    recoverable: [{ option: 'Partner', what: 'the agreement has a 90-day exit' }],
    smallest_reversible_step: 'A single-region pilot buys most of the information without the hiring.',
  },
  eisenhower: {
    compounds: [{ label: 'Build it', why: 'the integration work makes every later customer cheaper' }],
    buys_time: [{ label: 'Partner', why: 'it covers the quarter without changing your position' }],
    defer: [],
  },
  satisficing: {
    bar: 'a paying pilot live before March',
    clears_bar: [{ option: 'Partner', why: 'an integrator could be live in three weeks' }],
    cost_of_waiting: 'Another month of analysis costs you the March window entirely.',
  },
}

// ─── The conclusion is code ─────────────────────────────────────────────────

check('no lens reaches for a model to write its conclusion', () => {
  assert.ok(!/callLLM|postJson|PROMPTS|fetch\(|await /.test(source),
    'this is the line a founder repeats to someone else; a model writing it would eventually ' +
    'write an instruction, and the guard detects only after the fact')
})

check('every lens reaches a conclusion', () => {
  for (const id of LENSES) {
    const out = describeLens(id, normaliseLens(id, FIXTURES[id]), FRAME)
    assert.ok(out?.text?.length > 20, `${id} produced no conclusion`)
    assert.equal(out.decisive, true, `${id} should have reached something from a full fixture`)
  }
})

check('every conclusion is a judgment, not an instruction', () => {
  for (const id of LENSES) {
    const out = describeLens(id, normaliseLens(id, FIXTURES[id]), FRAME)
    const lower = out.text.toLowerCase()
    for (const phrase of ADVICE_PHRASES) {
      assert.ok(!lower.includes(phrase), `${id}'s conclusion contains "${phrase}"`)
    }
    // THE TEST: still true if the founder chooses the other way.
    assert.ok(!/^\s*(start|pick|choose|go with|avoid|don't)\b/i.test(out.text),
      `${id}'s conclusion opens as a command`)
  }
})

check('a lens that found nothing says so rather than padding', () => {
  const empties = {
    wrap: { unnamed_options: [] },
    regret: { unrecoverable: [] },
    eisenhower: { compounds: [], buys_time: [] },
    satisficing: { bar: '' },
  }
  for (const id of LENSES) {
    const out = describeLens(id, normaliseLens(id, empties[id]), FRAME)
    assert.equal(out.decisive, false, `${id} claimed a conclusion it did not reach`)
    assert.ok(out.text.length > 20, `${id} must still say something honest`)
  }
})

// ─── Normalising ────────────────────────────────────────────────────────────

check('an entry missing its load-bearing field is dropped, not half-rendered', () => {
  const w = normaliseLens('wrap', {
    unnamed_options: [{ label: 'Real' }, { why: 'no label' }, {}],
    reality_tests: [{ test: 'a pilot' }, { option: 'X' }],
  })
  assert.equal(w.unnamed_options.length, 1, 'an option with no label cannot be shown')
  assert.equal(w.reality_tests.length, 1, 'a reality test with no test is not a test')
})

check('every list is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `x${i}`, what: `w${i}`, test: `t${i}`, option: `o${i}` }))
  const w = normaliseLens('wrap', { unnamed_options: many, reality_tests: many })
  assert.ok(w.unnamed_options.length <= 5 && w.reality_tests.length <= 5,
    'a lens that returns fifteen of anything has stopped being a lens')
})

check('an unknown lens id returns null rather than an empty shape', () => {
  assert.equal(normaliseLens('nonsense', FIXTURES.wrap), null)
  assert.equal(describeLens('nonsense', null, FRAME), null)
  assert.equal(describeLens('wrap', null, FRAME), null)
})

check('normalising survives junk', () => {
  for (const id of LENSES) {
    for (const junk of [null, undefined, {}, 'a string', 42]) {
      assert.doesNotThrow(() => describeLens(id, normaliseLens(id, junk), FRAME))
    }
  }
})

// ─── The guard can find every prose field ───────────────────────────────────

check('lensProse reaches every model-written string', () => {
  // A field the guard cannot see is a field where advice ships unnoticed. Walk the fixture
  // and assert each planted phrase is found.
  for (const id of LENSES) {
    const block = normaliseLens(id, FIXTURES[id])
    const found = lensProse(id, block).map(([, text]) => text).join(' || ')
    const planted = JSON.stringify(block).match(/"(?:why|what|test|outside_view|asymmetry|smallest_reversible_step|bar|cost_of_waiting|condition|then)":"([^"]{10,})"/g) || []
    for (const p of planted) {
      const text = p.split('":"')[1].slice(0, -1)
      assert.ok(found.includes(text.slice(0, 30)),
        `${id}: lensProse never surfaces "${text.slice(0, 40)}…" — advice there would ship unseen`)
    }
  }
})

check('lensProse locates a hit rather than just reporting one', () => {
  const block = normaliseLens('regret', {
    ...FIXTURES.regret,
    unrecoverable: [{ option: 'Build it', what: 'You should not sign three-year contracts.' }],
  })
  const hit = lensProse('regret', block).find(([, t]) => /should not/i.test(t))
  assert.ok(hit, 'the guard must see it')
  assert.match(hit[0], /unrecoverable\[0\]\.what/,
    '"advice somewhere in the brief" is not actionable; the path is the whole value')
})

check('lensProse is silent on an absent block', () => {
  assert.deepEqual(lensProse('wrap', null), [])
  assert.deepEqual(lensProse(null, null), [])
})

// ─── Watch items ────────────────────────────────────────────────────────────

check("WRAP's tripwire becomes a watch item", () => {
  const out = harvestLensAssumptions('wrap', normaliseLens('wrap', FIXTURES.wrap), FRAME)
  assert.equal(out.length, 1)
  assert.match(out[0].question, /onboarding still takes over six weeks/)
  assert.equal(out[0].origin, 'decision')
  assert.equal(out[0].originRef, 'd1')
})

check("regret's irreversible parts become watch items, the recoverable ones do not", () => {
  const out = harvestLensAssumptions('regret', normaliseLens('regret', FIXTURES.regret), FRAME)
  assert.ok(out.some(q => /hiring commitment runs past your runway/.test(q.question)))
  assert.ok(!out.some(q => /90-day exit/.test(q.question)),
    'something that can be undone does not need watching for months')
})

check('sequencing and good-enough calls open nothing', () => {
  for (const id of ['eisenhower', 'satisficing']) {
    assert.deepEqual(harvestLensAssumptions(id, normaliseLens(id, FIXTURES[id]), FRAME), [],
      'these are re-made when circumstances change, not monitored between times')
  }
})

check('every watch item carries what to watch for', () => {
  for (const id of LENSES) {
    for (const q of harvestLensAssumptions(id, normaliseLens(id, FIXTURES[id]), FRAME)) {
      assert.ok(q.question && q.watchFor, `${id} produced a watch item with nothing to watch`)
    }
  }
})

// ─── Coverage of the lens set ───────────────────────────────────────────────

check('every non-weighing framework the router can choose has a lens here', () => {
  for (const id of FRAMEWORK_IDS) {
    if (id === 'mcda') continue
    assert.ok(normaliseLens(id, FIXTURES[id] || {}),
      `the router can route to "${id}" but no lens implements it — the founder would get a ` +
      `named framework and an empty analysis`)
  }
})

check('nothing is mutated', () => {
  const before = JSON.stringify(FIXTURES)
  for (const id of LENSES) describeLens(id, normaliseLens(id, FIXTURES[id]), FRAME)
  assert.equal(JSON.stringify(FIXTURES), before)
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
