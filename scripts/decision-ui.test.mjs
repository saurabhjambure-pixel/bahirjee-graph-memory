/**
 * The decision session's screens.
 *
 * Source-level assertions, because the two things most worth protecting here are structural
 * and both would survive any visual check:
 *
 *   1. THE WEIGHTS ARE EDITABLE AND THE SCORES ARE NOT. Weights are the founder's half of
 *      the analysis; scores are claims about the world with evidence attached. Letting
 *      someone overwrite a score would turn "argue with the reasoning" into "edit the
 *      evidence", and the artifact would stop meaning anything.
 *
 *   2. AN UNSCORED CELL IS NOT A ZERO. Rendering 0 for "we did not find out" reads as
 *      "bad at this" — the same conflation decisionScoring refuses in the arithmetic, which
 *      the UI could quietly reintroduce at the last step.
 *
 * Run: npm run test:decision-ui
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const view = read('../src/components/intelligence/DecisionJudgmentView.jsx')
const session = read('../src/components/intelligence/DecisionSession.jsx')
const frameworks = read('../src/services/decisionFrameworks.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

check('the weights are live, and recomputed by the same arithmetic as the brief', () => {
  assert.match(view, /import \{[^}]*scoreOptions[^}]*sensitivity[^}]*describeLeaning/s,
    'a second re-weighing implementation in the UI would drift from the persisted one, and ' +
    'the founder would see two different answers to the same question')
  assert.match(view, /type="range"/)
  assert.match(view, /onChange=\{\(e\) => \{[\s\S]*?setWeights/,
    'the slider must recompute, not merely display')
})

check('scores are rendered, never edited', () => {
  const scoreCell = view.slice(view.indexOf('const s = scoreFor'), view.indexOf('</td>', view.indexOf('const s = scoreFor')))
  assert.ok(!/<input|contentEditable|onChange/.test(scoreCell),
    'overwriting a score edits the evidence rather than your own priorities — that ' +
    'disagreement belongs in the interrogation box')
})

check('an unscored cell says so instead of showing a zero', () => {
  assert.match(view, /Not established/,
    'rendering 0 for "we did not find out" reads as "bad at this" — the exact conflation ' +
    'the arithmetic refuses, reintroduced at the last step')
})

check('the founder can return to the original weights', () => {
  assert.match(view, /setWeights\(null\)/, 'having moved sliders, they must be able to get back')
  assert.match(view, /Recalculated with your weights/,
    'and it must be obvious when what they are reading is no longer what was saved')
})

check('the lens and why it was chosen lead the screen', () => {
  const lensAt = view.indexOf('judgment.framework?.why')
  const leaningAt = view.indexOf('leaning.text')
  assert.ok(lensAt !== -1 && lensAt < leaningAt,
    'the method has to arrive before the conclusion, or it reads as justification after the fact')
  assert.match(view, /what_would_change_it/, 'and what would have chosen differently')
})

check('confidence is shown with its basis, never alone', () => {
  assert.match(view, /confidence\.level[\s\S]{0,120}confidence\.basis/,
    'a level with no basis is asserted rather than auditable')
})

check('the choice is offered, never assumed', () => {
  assert.match(view, /What did you decide\?/)
  assert.match(view, /including if you go the other way/,
    'Bahirjee watches the assumptions behind whichever they pick, not behind its own lean')
  assert.ok(!/leader[\s\S]{0,80}onRecordChoice|onRecordChoice\([^)]*leader/.test(view),
    'pre-selecting its own lean would record a decision the founder never made')
})

check('options are never fabricated', () => {
  assert.match(session, /I did not hear any distinct options/,
    'a guessed option would be scored, weighed and ranked — carrying a hallucination into ' +
    'a board meeting')
  assert.match(session, /will not invent any you did not say/)
})

check('the questions come from the router, not from a hardcoded list', () => {
  assert.match(session, /questionsFor\(frame\)/,
    'a second copy of the questions would drift from what routeFramework actually reads')
  assert.ok(!/reversibility[\s\S]{0,200}worst_case[\s\S]{0,200}delay_cost/.test(session),
    'the session must not restate the question set')
})

check('the session says what it can find out for itself', () => {
  assert.match(session, /I can look up[\s\S]{0,200}What I can't know/,
    'this sentence is what makes it feel like working with someone rather than a form')
})

check('the lens is previewed before the founder commits to the work', () => {
  assert.match(session, /How I'll look at this/)
  assert.match(session, /routeFramework\(frame, answers\)/,
    'announcing a method only after the analysis leaves nothing to query')
})

check('the submit is blocked until every routing question is answered', () => {
  assert.match(session, /missingAnswers/)
  assert.match(session, /disabled=\{outstanding\.length > 0/,
    'a lens chosen from half the answers is chosen from nothing, confidently')
})

check('every framework the router can choose renders somewhere', () => {
  const ids = [...frameworks.matchAll(/^\s{4}(\w+): \{$/gm)].map(m => m[1])
  for (const id of ids) {
    if (id === 'mcda') continue // rendered as the scorecard, not a lens block
    assert.ok(view.includes(`id === '${id}'`),
      `the router can route to "${id}" but DecisionJudgmentView never renders it — the ` +
      `founder would get a named lens and a blank panel`)
  }
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
