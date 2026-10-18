/**
 * Express lane guards.
 *
 * The express step exists so the first grounded signals land ~60s into a run instead of
 * ~2.5 minutes. It runs before competitor discovery and before query generation, on
 * nothing but the context the founder just confirmed.
 *
 * Two failure shapes are pinned here, both of the kind the engineering notes warns about — nothing
 * throws, the report is just quietly worse:
 *   • express observations analysed twice (once by express, once by the main plan),
 *     costing an LLM batch and producing duplicate signals
 *   • express observations analysed OUTSIDE the observation ceiling, so a run silently
 *     exceeds the cap that governs its cost
 *
 * Run: npm run test:express
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildExpressQueries } from '../src/services/queryGenerator.js'
import { RUN_TIERS, depthGapsFor } from '../src/services/runTiers.js'
import { PIPELINE_STEP_LABELS, TOTAL_PIPELINE_STEPS, resolveStepIndex } from '../src/services/pipelineSteps.js'
import { agentIdForStep, isAgentEntry, isAgentBoundary, GRAPH_VERSION } from '../src/services/agents/registry.js'
import { getAgent } from '../src/services/agents/registry.js'

const SRC = fs.readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
const WORKER = fs.readFileSync(new URL('../lib/_intelligenceWorker.js', import.meta.url), 'utf8')
const RESUME = fs.readFileSync(new URL('../lib/handlers/intelligence.js', import.meta.url), 'utf8')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const CONTEXT = {
  company_name: 'HG Insights',
  industry: 'B2B data intelligence',
  operating_geography: 'US',
  key_competitors: ['ZoomInfo', { name: 'Clearbit' }]
}

console.log('\nExpress lane\n')

check('queries build from the confirmed context alone, with no LLM call', () => {
  const qs = buildExpressQueries(CONTEXT, 3)
  assert.equal(qs.length, 3)
  assert.ok(qs.every(q => typeof q === 'string' && q.trim().length > 0))
  assert.ok(qs.some(q => q.includes('ZoomInfo')), 'the founder-confirmed competitor must be searched')
  assert.ok(qs.some(q => q.includes('HG Insights')), 'the company itself must be searched')
})

check('queries are deterministic — same context, same set', () => {
  assert.deepEqual(buildExpressQueries(CONTEXT, 3), buildExpressQueries(CONTEXT, 3))
})

check('degrades to industry queries when the context is thin', () => {
  const qs = buildExpressQueries({}, 3)
  assert.ok(qs.length > 0, 'a bare context must still produce something searchable')
  assert.ok(qs.every(Boolean))
  assert.deepEqual(buildExpressQueries(null, 3), buildExpressQueries({}, 3), 'null context must not throw')
})

check('respects its limit and never returns duplicates', () => {
  for (const n of [0, 1, 2, 3, 6, 50]) {
    const qs = buildExpressQueries(CONTEXT, n)
    assert.ok(qs.length <= n, `asked for ${n}, got ${qs.length}`)
    assert.equal(new Set(qs).size, qs.length, 'duplicate express queries waste the budget')
  }
})

check('express queries are ADDITIVE to the tier budget, never deducted', () => {
  // The floors are re-derived per tier and already claim 21 of 22 (full) and 7 of 8
  // (shallow). Deducting express would over-subscribe both and starve the founder's own
  // question of its reserved coverage.
  for (const tier of ['shallow', 'full']) {
    const t = RUN_TIERS[tier]
    assert.ok(Number.isInteger(t.expressQueries) && t.expressQueries > 0, `${tier} declares expressQueries`)
    const floors = t.inquiryQueryFloor + t.tierQueryFloor + t.docQueryFloor + t.demandQueryFloor
    assert.ok(floors <= t.maxQueries, `${tier}: floors (${floors}) must still fit maxQueries (${t.maxQueries})`)
  }
})

check('the paywall states the real search count, including express', () => {
  // This is the one surface whose entire argument is honesty about the evidence.
  const gap = depthGapsFor('shallow')[0]
  const full = RUN_TIERS.full.maxQueries + RUN_TIERS.full.expressQueries
  const shallow = RUN_TIERS.shallow.maxQueries + RUN_TIERS.shallow.expressQueries
  assert.ok(gap.includes(String(full)), `"${gap}" must name the true full-run count ${full}`)
  assert.ok(gap.includes(String(shallow)), `"${gap}" must name the true shallow count ${shallow}`)
  assert.deepEqual(depthGapsFor('full'), [], 'a full run still discloses no gaps')
})

check('express is registered as a step, right after memory', () => {
  const names = PIPELINE_STEP_LABELS.map(s => s.name)
  assert.equal(names[names.indexOf('memory') + 1], 'express', 'express must run immediately after memory')
  assert.ok(names.indexOf('express') < names.indexOf('discover_competitors'))
  assert.equal(TOTAL_PIPELINE_STEPS, names.length, 'the total is derived, never hardcoded')
})

check('its label resolves to its own step and collides with no other', () => {
  const express = PIPELINE_STEP_LABELS.find(s => s.name === 'express')
  assert.equal(resolveStepIndex(express.label), PIPELINE_STEP_LABELS.indexOf(express))
  assert.equal(resolveStepIndex(`${express.label}...`), PIPELINE_STEP_LABELS.indexOf(express))
  for (const other of PIPELINE_STEP_LABELS) {
    if (other.name === 'express') continue
    assert.ok(
      !other.label.toLowerCase().startsWith(express.label.toLowerCase()),
      `"${other.label}" is prefixed by the express label — resolveStepIndex would mismatch`
    )
  }
})

check('express owns its own single-step agent, granted EXA', () => {
  const id = agentIdForStep('express')
  assert.equal(id, 'express_agent', 'a step with no owning agent fails validateRegistry at import')
  assert.ok(isAgentEntry('express') && isAgentBoundary('express'), 'single-step agents open and close together')
  const spec = getAgent(id)
  // searchQuery falls back to Exa when Tavily errors; under strict enforcement an
  // ungranted /api/exa call fails the WHOLE run, and only when Tavily is down.
  assert.ok(spec.allowed_tools.includes('exa'), 'express must be granted EXA for the Tavily fallback')
  assert.ok(spec.allowed_tools.includes('tavily'))
  assert.ok(spec.allowed_tools.includes('llm'))
  assert.equal(spec.escalation_policy, 'degrade_and_continue', 'express is an accelerator, never a dependency')
})

check('the graph version moved, so v3 checkpoints re-queue instead of skipping express', () => {
  assert.notEqual(GRAPH_VERSION, 'v3', 'adding a step without bumping the graph lets old checkpoints skip it')
})

check('express contributes to the forward-progress fingerprint', () => {
  // A cursored step that defers without moving a watched cursor looks identical across
  // invocations and aborts the run. The assertion is on the literal text of cursorOf.
  const cursorOf = WORKER.slice(WORKER.indexOf('const cursorOf'), WORKER.indexOf('const cursorBefore'))
  assert.ok(/s\.express\?\./.test(cursorOf), 'cursorOf must read s.express?.<cursor>')
})

check('every express defer moves the cursor, including a no-work one', () => {
  const step = SRC.slice(SRC.indexOf('async function stepExpress'), SRC.indexOf('async function stepDiscoverCompetitors'))
  const deferBlock = step.slice(step.indexOf('const deferOrSkip'), step.indexOf('try {'))
  assert.ok(/e\.deferCount \+= 1/.test(deferBlock), 'defers must be bounded')
  assert.ok(/e\.cursor \+= 1/.test(deferBlock), 'a defer that does not move the cursor trips the progress guard')
})

check('express is skipped in the monolith driver, declaratively', () => {
  assert.ok(/steppedOnly: true/.test(SRC), 'the registry entry must declare it')
  assert.ok(/if \(step\.steppedOnly\) continue;/.test(SRC), 'the monolith loop must honour it')
})

// The exclusion and the ceiling live in analyzeInput(), which `triage` and `analyze` both
// call so the rows triage scores are exactly the rows analysis receives.
const ANALYZE_INPUT = SRC.slice(SRC.indexOf('async function analyzeInput'), SRC.indexOf('async function stepTriage'))

check('triage and analyze plan over the same express-excluded population', () => {
  assert.ok(ANALYZE_INPUT.length > 0, 'analyzeInput() is gone — the exclusion rules below have nowhere to live')
  for (const step of ['stepTriage', 'stepAnalyze']) {
    const body = SRC.slice(SRC.indexOf(`async function ${step}`))
    const end = body.indexOf('\nasync function ', 1)
    assert.ok(/await analyzeInput\(state\)/.test(body.slice(0, end)), `${step} must take its population from analyzeInput()`)
  }
})

check('express observations are excluded from the main analyze plan by id AND url', () => {
  const analyze = ANALYZE_INPUT
  assert.ok(/state\.express\?\.obsIds/.test(analyze), 'must exclude by observation id')
  assert.ok(/state\.express\?\.urlKeys/.test(analyze), 'must ALSO exclude by normalized url')
  assert.ok(/normalizeObservationUrl\(o\.url\)/.test(analyze), 'the url comparison must be normalized')
})

check('a deep read is not excluded because express already saw its snippet', () => {
  const analyze = ANALYZE_INPUT
  assert.ok(/o\.isDeepRead \|\| !expressUrls\.has\(/.test(analyze),
    'express read the snippet; the full page is evidence it never had')
})

check('the observation ceiling accounts for what express already spent', () => {
  const analyze = ANALYZE_INPUT
  assert.ok(
    /budget\(\)\.maxObservations - \(state\.express\?\.analyzedCount \|\| 0\)/.test(analyze),
    'analysing express observations outside the cap silently raises the run cost'
  )
  const step = SRC.slice(SRC.indexOf('async function stepAnalyze'), SRC.indexOf('a.signals = deduplicateSignals'))
  assert.ok(/planAnalyzeBatches\(observations, remainingCap[,)]/.test(step), 'analyze must plan against the reduced ceiling')
})

check('planAnalyzeBatches keeps its default cap for existing callers', () => {
  assert.ok(
    /export function planAnalyzeBatches\(observations, cap = null[,)]/.test(SRC),
    'the cap must be optional so golden-cases callers are untouched'
  )
})

check('express signals are seeded inside the state.analyze literal', () => {
  // Pre-creating state.analyze skips the plan block (stepAnalyze guards on !state.analyze)
  // and the batch loop then throws on a.batches.length.
  const step = SRC.slice(SRC.indexOf('async function stepExpress'), SRC.indexOf('async function stepDiscoverCompetitors'))
  assert.ok(!/state\.analyze\s*=/.test(step), 'express must NEVER assign state.analyze')
  assert.ok(
    /signals: \[\.\.\.\(state\.express\?\.signals \|\| \[\]\)\]/.test(SRC),
    'the seed must live inside the object literal so it survives the empty early-return'
  )
})

check('an empty plan still falls through when express contributed signals', () => {
  assert.ok(
    /if \(a\.empty && a\.signals\.length === 0\) return;/.test(SRC),
    'otherwise express signals skip dedupe and the freshness downgrade'
  )
})

check('express stamps its own id prefix, not the one stepAnalyze uses', () => {
  const step = SRC.slice(SRC.indexOf('async function stepExpress'), SRC.indexOf('async function stepDiscoverCompetitors'))
  assert.ok(/`exp:\$\{i\}`/.test(step), 'reusing mem: invites a silent id collision')
  assert.ok(!/`mem:\$\{i\}`/.test(step))
})

check('express runs the same grounding filter chain as stepAnalyze', () => {
  const step = SRC.slice(SRC.indexOf('async function stepExpress'), SRC.indexOf('async function stepDiscoverCompetitors'))
  assert.ok(/applySignalFilters\(/.test(step), 'a weaker path would publish what a normal signal could not')
  assert.ok(/normalizeSignalResponse\(/.test(step))
})

check('express fails open — the run continues and the shortfall is disclosed', () => {
  const step = SRC.slice(SRC.indexOf('async function stepExpress'), SRC.indexOf('async function stepDiscoverCompetitors'))
  assert.ok(/catch \(err\)/.test(step), 'an express failure must never propagate')
  assert.ok(/recordDegradation\(/.test(step), 'and must never be silent either')
})

check('a stale checkpoint is refused BEFORE the free run is reserved', () => {
  const resume = RESUME.slice(RESUME.indexOf('async function handleResumeJob'), RESUME.indexOf('async function handleGetJob'))
  // Match the CALLS, not prose — a comment naming either function must not sway this.
  const compatAt = resume.indexOf('const compat = checkGraphCompatibility(')
  const reserveAt = resume.indexOf('await reserveFounderRun(')
  assert.ok(compatAt !== -1, 'resume must check graph compatibility')
  assert.ok(reserveAt !== -1)
  assert.ok(
    compatAt < reserveAt,
    'reserving first spends the founder\'s only free run on a job the worker will refuse'
  )
})

console.log(`\n${passed} checks passed\n`)
