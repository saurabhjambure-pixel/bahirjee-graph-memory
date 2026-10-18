/**
 * Running a decision session.
 *
 * The fourth driver over PIPELINE_STEPS, and the one with a founder watching it. Three
 * things must hold, and all three fail silently if they stop:
 *
 *   1. EXACTLY ONE MODEL CALL. The router has already chosen the lens. Calling both
 *      weighDecision and deliberate would double the cost of the most expensive interaction
 *      in the product and give the losing call's prose a chance to leak into the output.
 *
 *   2. VERIFY STILL RUNS. A decision brief may go into a board meeting. It does not get a
 *      relaxed grounding gate for being quicker than a full run.
 *
 *   3. NOTHING THROWS INTO THE SCREEN. A founder four questions deep must never be handed
 *      an error page. Every stage degrades to something honest and thinner.
 *
 * Run: npm run test:decision-run
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RUN_TIERS } from '../src/services/runTiers.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const run = read('../src/services/decisionRun.js')
const dashboard = read('../src/components/IntelligenceDashboard.jsx')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

check('exactly one model call fires per session', () => {
  const fn = run.slice(run.indexOf('export async function deliberateDecision'))
  assert.match(fn, /isWeighing\s*\?[\s\S]{0,400}weighDecision[\s\S]{0,400}:\s*await callLLMAction\('deliberate'/,
    'the two calls must be branches of one ternary, not two statements — the router already ' +
    'chose, and running both doubles the cost of the most expensive interaction here')
  assert.equal((run.match(/callLLMAction\(/g) || []).length, 2, 'exactly the two branches, nowhere else')
})

check('the grounding gate runs, same as a full run', () => {
  assert.match(run, /runToCompletion\('verify'/,
    'a decision brief may go into a board meeting; it does not get a relaxed gate for being quicker')
  const order = ['search', 'analyze', 'verify'].map(s => run.indexOf(`runToCompletion('${s}'`))
  assert.ok(order[0] < order[1] && order[1] < order[2], 'and in the same order')
})

check('the decision budget is the registered tier, never a local object', () => {
  assert.match(run, /configureIntelligenceRuntime\(\{ budget: RUN_TIERS\.decision \}\)/,
    'resolution is BY NAME through RUN_TIERS — a budget defined elsewhere resolves to full, ' +
    'which is the seven-fold overspend the daily loop already shipped once')
  assert.equal(RUN_TIERS.decision.name, 'decision')
  assert.ok(RUN_TIERS.decision.maxQueries < RUN_TIERS.full.maxQueries, 'a founder is waiting')
  assert.ok(RUN_TIERS.decision.maxQueries > RUN_TIERS.daily.maxQueries, 'and this is a real choice')
})

check('nothing is searched when nothing is missing', () => {
  const fn = run.slice(run.indexOf('export async function gatherDecisionEvidence'))
  assert.match(fn, /plan\.gaps\.length === 0 && plan\.hasInternal/,
    'spending searches to re-learn what is already on file is the waste the Agenda ended, ' +
    'one layer up — and worse here, because the founder is waiting')
  assert.ok(fn.indexOf('assembleInternalEvidence') < fn.indexOf('buildDecisionQueries'),
    'internal evidence must be consulted before queries are built, not after')
})

check('only the gaps are searched', () => {
  const fn = run.slice(run.indexOf('export async function gatherDecisionEvidence'))
  assert.match(fn, /sub_questions: plan\.gaps\.length \? plan\.gaps : frame\?\.sub_questions/,
    'the queries must be built from what is missing, not from the whole frame')
})

check('the founder\'s own material is cited first', () => {
  assert.match(run, /\[\.\.\.plan\.internal\.signals, \.\.\.found\]/,
    'the model cites by position, and their own material should not be buried behind search results')
})

check('every stage degrades instead of throwing', () => {
  for (const fnName of ['gatherDecisionEvidence', 'deliberateDecision']) {
    const fn = run.slice(run.indexOf(`export async function ${fnName}`))
    assert.match(fn.slice(0, 3000), /catch \(err\)/, `${fnName} must not throw into the screen`)
  }
  assert.match(run, /Showing what I have/, 'a failed analysis still shows the lens and what was known')
})

check('a failed analysis still returns a brief', () => {
  const fn = run.slice(run.indexOf('export async function deliberateDecision'))
  const afterCatch = fn.slice(fn.indexOf('catch (err)'))
  assert.match(afterCatch, /return buildDecisionBrief/,
    'the founder still gets the lens, why it was chosen, and the evidence already on file — ' +
    'more than they had before')
})

// ─── The dashboard wiring ───────────────────────────────────────────────────

check('the Desk button opens a real session, not the old textarea heuristic', () => {
  assert.match(dashboard, /onAskDecision=\{openDecision\}/)
  assert.ok(!/onAskDecision=\{\(\) => \{ setAnalysisMode\('decision'\); setShowIntake\(true\); \}\}/.test(dashboard),
    'decision mode used to be inferred from typing 12 characters into an intake box')
})

check('a failed persist does not cost the founder their session', () => {
  const fn = dashboard.slice(dashboard.indexOf('const handleDecisionFrame'))
  assert.match(fn.slice(0, 1200), /session\?\.id \|\| null/,
    'losing the analysis to protect the record would be backwards — only the revisit is lost')
})

check('session state outlives the component', () => {
  assert.match(dashboard, /const \[decision, setDecision\] = useState\(null\)/,
    'a founder who navigates away mid-session must not have to answer four questions again')
})

check('the choice is recorded through the service that owns the CHECK', () => {
  assert.match(dashboard, /recordChoice\(decision\.sessionId, optionId\)/)
  assert.ok(!/from\('decision_briefs'\)/.test(dashboard),
    'a direct write would bypass the choice/date CHECK and the framework validation')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
