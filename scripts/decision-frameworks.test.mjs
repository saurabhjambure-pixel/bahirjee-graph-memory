/**
 * Choosing the lens.
 *
 * The product claim in Phase 2 is that a judgment is defensible because the METHOD was
 * chosen for a stated reason, not because the conclusion sounds confident. That claim rests
 * entirely on this router being deterministic and legible — a model asked "which framework
 * applies?" would answer differently on Tuesday, and there would be nothing to argue with.
 *
 * Two invariants carry the weight:
 *
 *   1. EVERY QUESTION ASKED IS A QUESTION USED. Bahirjee asks a founder only for what it
 *      cannot look up. The moment a question exists that the router does not branch on,
 *      the interrogation becomes a form — and forms are what the Desk replaced.
 *
 *   2. THE ROUTING IS ORDERED BY SHAPE, THEN STAKES. "These aren't alternatives" and
 *      "there's only one option" are facts about what KIND of question this is, and they
 *      have to be settled before any weighing, or the analysis answers a question nobody
 *      asked.
 *
 * Run: npm run test:frameworks
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  FRAMEWORKS,
  FRAMEWORK_IDS,
  DECISION_QUESTIONS,
  routeFramework,
  missingAnswers,
  questionsFor,
} from '../src/services/decisionFrameworks.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const source = read('../src/services/decisionFrameworks.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const frame = (n) => ({ options: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) })
const ANSWERS = { exclusive: true, reversibility: 'easy', worst_case: 'survivable', delay_cost: 'none' }

// ─── Purity ─────────────────────────────────────────────────────────────────

check('routing is deterministic code, not a prompt', () => {
  assert.ok(!/callLLM|postJson|fetch\(|await /.test(source),
    'a model asked which framework applies would answer differently on Tuesday, and a ' +
    'founder would have nothing to argue with')
  assert.ok(!/Date\.now\(\)|new Date\(/.test(source), 'no clock: the same decision routes the same way')
})

check('the same inputs always give the same lens', () => {
  const a = routeFramework(frame(3), ANSWERS)
  const b = routeFramework(frame(3), ANSWERS)
  assert.equal(a.framework.id, b.framework.id)
  assert.equal(a.why, b.why)
})

// ─── Every question asked is a question used ────────────────────────────────

check('the router branches on every question it asks', () => {
  const fn = source.slice(source.indexOf('export function routeFramework'))
  for (const q of DECISION_QUESTIONS) {
    // `worst_case` is destructured to `worstCase`, so accept either spelling.
    const camel = q.id.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    assert.ok(
      fn.includes(q.id) || fn.includes(camel),
      `"${q.id}" is asked of the founder but routeFramework never reads it — asking for ` +
      `something you will not use is how an interrogation becomes a form`
    )
  }
})

check('the router reads nothing it did not ask for', () => {
  const fn = source.slice(source.indexOf('export function routeFramework'), source.indexOf('export function missingAnswers'))
  const destructured = fn.match(/const \{([^}]*)\} = answers/)[1]
  const fields = destructured.split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
  const asked = new Set(DECISION_QUESTIONS.map(q => q.id))
  for (const f of fields) {
    assert.ok(asked.has(f), `routeFramework reads answers.${f}, which is never asked — it ` +
      `would be undefined on every real session`)
  }
})

check('every question offers answers a person can actually pick', () => {
  for (const q of DECISION_QUESTIONS) {
    assert.ok(q.question.endsWith('?'), `"${q.id}" must be a question`)
    assert.ok(q.why && q.why.length > 20, `"${q.id}" must say why it is being asked`)
    assert.ok(q.options.length >= 2, `"${q.id}" needs real choices`)
    for (const o of q.options) assert.ok(o.label && o.value !== undefined)
  }
})

check('the questions are ones Bahirjee genuinely cannot look up', () => {
  // Reversibility, downside, cost of delay and exclusivity are facts about the founder's
  // own situation and appetite. Anything researchable — what a rival charges, what the
  // regulator said — must NOT be asked; Bahirjee goes and finds that itself.
  const text = DECISION_QUESTIONS.map(q => q.question.toLowerCase()).join(' ')
  for (const researchable of ['competitor', 'market size', 'pricing', 'regulation', 'how many customers']) {
    assert.ok(!text.includes(researchable),
      `asking the founder about "${researchable}" wastes the one thing only they can answer`)
  }
  assert.equal(DECISION_QUESTIONS.length, 4, 'four questions; a fifth needs to earn its place')
})

// ─── Shape before stakes ────────────────────────────────────────────────────

check('not either/or → urgent vs important, whatever the stakes', () => {
  const r = routeFramework(frame(3), { ...ANSWERS, exclusive: false, reversibility: 'irreversible', worst_case: 'existential' })
  assert.equal(r.framework.id, 'eisenhower',
    'if the founder wants several of these, treating it as a choice between alternatives ' +
    'answers a question nobody asked — even when the stakes are severe')
})

check('one option → widen, before anything is weighed', () => {
  const r = routeFramework(frame(1), ANSWERS)
  assert.equal(r.framework.id, 'wrap')
  assert.match(r.why, /one option/i)
})

check('no options named → widen', () => {
  assert.equal(routeFramework(frame(0), ANSWERS).framework.id, 'wrap')
  assert.equal(routeFramework({}, ANSWERS).framework.id, 'wrap')
  assert.equal(routeFramework(null, ANSWERS).framework.id, 'wrap')
})

check('one option outranks severe stakes — you cannot weigh what is not named', () => {
  const r = routeFramework(frame(1), { ...ANSWERS, reversibility: 'irreversible', worst_case: 'existential' })
  assert.equal(r.framework.id, 'wrap')
})

// ─── Stakes ─────────────────────────────────────────────────────────────────

check('irreversible with a severe downside → minimise regret', () => {
  for (const reversibility of ['irreversible', 'costly']) {
    for (const worst_case of ['existential', 'serious']) {
      const r = routeFramework(frame(2), { ...ANSWERS, reversibility, worst_case })
      assert.equal(r.framework.id, 'regret', `${reversibility} + ${worst_case} should be regret`)
    }
  }
})

check('hard to undo but survivable is still a trade-off problem', () => {
  const r = routeFramework(frame(2), { ...ANSWERS, reversibility: 'irreversible', worst_case: 'survivable' })
  assert.equal(r.framework.id, 'mcda',
    'irreversibility alone does not justify the slower lens — plenty of one-way doors are cheap')
})

check('reversible, survivable, closing window → good enough, soon', () => {
  const r = routeFramework(frame(3), { exclusive: true, reversibility: 'easy', worst_case: 'survivable', delay_cost: 'high' })
  assert.equal(r.framework.id, 'satisficing')
  assert.match(r.why, /window|analysis/i)
})

check('the same decision without time pressure is a trade-off problem', () => {
  const r = routeFramework(frame(3), { exclusive: true, reversibility: 'easy', worst_case: 'survivable', delay_cost: 'none' })
  assert.equal(r.framework.id, 'mcda', 'satisficing is justified by the cost of delay, not by low stakes alone')
})

check('a real comparison with trade-offs → weigh them', () => {
  const r = routeFramework(frame(3), ANSWERS)
  assert.equal(r.framework.id, 'mcda')
  assert.match(r.why, /3 real options/)
})

// ─── Defensibility ──────────────────────────────────────────────────────────

check('every route states why, in the founder\'s own terms', () => {
  const cases = [
    [frame(3), { ...ANSWERS, exclusive: false }],
    [frame(1), ANSWERS],
    [frame(2), { ...ANSWERS, reversibility: 'irreversible', worst_case: 'existential' }],
    [frame(3), { ...ANSWERS, delay_cost: 'high' }],
    [frame(3), ANSWERS],
  ]
  for (const [f, a] of cases) {
    const r = routeFramework(f, a)
    assert.ok(r.why && r.why.length > 30, `${r.framework.id} gave no real reason`)
    assert.ok(/^[A-Z]/.test(r.why) && r.why.endsWith('.'), 'the reason is shown to a founder')
    assert.ok(!/[_A-Z]{4,}/.test(r.why), 'no internal vocabulary in founder-facing copy')
  }
})

check('every route names what would have changed it', () => {
  // This is the routing's own sensitivity. Without it a founder can only argue with the
  // conclusion; with it they can argue with the method, which is the better conversation.
  for (const [f, a] of [[frame(3), ANSWERS], [frame(1), ANSWERS], [frame(3), { ...ANSWERS, exclusive: false }]]) {
    const r = routeFramework(f, a)
    assert.ok(r.whatWouldChangeIt && r.whatWouldChangeIt.length > 20,
      `${r.framework.id} does not say what would have routed it elsewhere`)
  }
})

check('every framework is described so a founder can tell them apart', () => {
  for (const id of FRAMEWORK_IDS) {
    const f = FRAMEWORKS[id]
    assert.ok(f.name && f.formal && f.when && f.asks, `${id} is underspecified`)
    // The plain name leads; the formal name is available for anyone who wants to look it
    // up or cite it in a board pack, but it is not what the interface says first.
    assert.notEqual(f.name, f.formal)
  }
  assert.equal(FRAMEWORK_IDS.length, 5)
})

// ─── Partial answers ────────────────────────────────────────────────────────

check('missing answers are named, not silently defaulted', () => {
  assert.deepEqual(missingAnswers({}).sort(), DECISION_QUESTIONS.map(q => q.id).sort())
  assert.deepEqual(missingAnswers(ANSWERS), [])
  assert.deepEqual(missingAnswers({ ...ANSWERS, worst_case: null }), ['worst_case'])
})

check('an unanswered session still routes, to the safe default', () => {
  const r = routeFramework(frame(3), {})
  assert.equal(r.framework.id, 'mcda', 'with nothing known, a real comparison is the safe lens')
  assert.deepEqual(r.answered, [], 'and it must be honest that it was chosen from nothing')
})

check('answered records exactly what was actually supplied', () => {
  const r = routeFramework(frame(3), { reversibility: 'easy', worst_case: undefined, delay_cost: null })
  assert.deepEqual(r.answered, ['reversibility'])
})

// ─── The asked set ──────────────────────────────────────────────────────────

check('a single-option frame is not asked whether its options are either/or', () => {
  assert.ok(!questionsFor(frame(1)).some(q => q.id === 'exclusive'),
    'a question with one possible answer is a form field, not an interrogation')
  assert.equal(questionsFor(frame(1)).length, 3)
  assert.equal(questionsFor(frame(3)).length, 4)
})

check('routing never mutates what it was given', () => {
  const f = frame(2), a = { ...ANSWERS }
  const fBefore = JSON.stringify(f), aBefore = JSON.stringify(a)
  routeFramework(f, a)
  assert.equal(JSON.stringify(f), fBefore)
  assert.equal(JSON.stringify(a), aBefore)
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
