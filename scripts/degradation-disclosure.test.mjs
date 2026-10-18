/**
 * Degradation disclosure guards — §0.2 of the internal multi-agent plan.
 *
 * The pipeline is full of failures that must NOT abort the run: a dead scrape, a rejected
 * observation write, one analysis batch that exhausts its retries, a memory-layer write that
 * cannot reach Postgres. That design is correct — per the internal design log, "a failed
 * watch must never fail the run".
 *
 * The defect was that non-blocking got implemented as *invisible* rather than as *disclosed*.
 * Every one of these sites used to swallow the failure into a console line nobody reads,
 * and the founder received a quietly thinner report with nothing saying why. The worst
 * instance cost two entire evidence classes for months (see observation-source-types.test.mjs).
 *
 * Each assertion below pins one site's disclosure. They are source-shape assertions rather
 * than behavioural ones because every site is wired to the LLM gateway, the invocation-budget
 * timer, or Supabase — mocking all three is a far larger fixture than the guard is worth, and
 * scripts/security-smoke-tests.mjs already establishes source-shape checks as the idiom here.
 *
 * If a refactor moves this logic, carry the assertion with it. Do not delete it to go green:
 * a gap is never closed by lowering the bar.
 *
 * Run: npm run test:disclosure
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { recordDegradation, createPipelineState } from '../src/services/intelligenceService.js'

const SRC = fs.readFileSync(
  new URL('../src/services/intelligenceService.js', import.meta.url),
  'utf8'
)

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

/** Slice one function body out by its declaration and a trailing marker. */
function sliceFn(startNeedle, endNeedle) {
  const start = SRC.indexOf(startNeedle)
  assert.ok(start >= 0, `"${startNeedle}" not found — renamed or moved?`)
  const end = SRC.indexOf(endNeedle, start)
  assert.ok(end > start, `end marker "${endNeedle}" not found after "${startNeedle}"`)
  return SRC.slice(start, end)
}

console.log('\ndegradation disclosure')

// ── 0. the mechanism actually exists and works ───────────────────────────────
//
// This block exists because everything below it once passed against code that could not
// run. The assertions further down grep for CALL SITES; they cannot tell a resolved symbol
// from a dangling one. `recordDegradation` was a `main`-only function, this branch never
// had it, and a conflict resolution left three live calls to a name with no definition.
// Every static assertion stayed green; the first real pipeline run died with
// "recordDegradation is not defined" in the analyze step.
//
// Lesson kept in code rather than in a commit message: a guard that greps must be paired
// with one that executes.
check('recordDegradation is defined, exported, and records onto pipeline state', () => {
  assert.equal(typeof recordDegradation, 'function', 'recordDegradation must be exported — grep-only guards cannot catch a dangling call')

  const state = createPipelineState({ company_name: 'Acme' }, 'run-x')
  assert.ok(Array.isArray(state.degradations), 'createPipelineState must seed a degradations ledger')

  recordDegradation(state, { step: 'Source watch', reason: 'nothing stored', impact: 'evidence missing' })
  assert.equal(state.degradations.length, 1, 'the degradation was not recorded')
  const d = state.degradations[0]
  assert.equal(d.step, 'Source watch')
  assert.equal(d.impact, 'evidence missing')
  assert.ok(d.at, 'a degradation must carry a timestamp')

  // Must never throw: bookkeeping cannot be what breaks a run.
  assert.doesNotThrow(() => recordDegradation(null, { step: 'x', reason: 'y' }), 'must tolerate a null state')
  assert.doesNotThrow(() => recordDegradation({}, { step: 'x', reason: 'y' }), 'must tolerate a state with no ledger')
})

check('degradations reach the report payload', () => {
  // Recording into state is useless if the field never ships. Both report-shaping paths
  // (the empty-signal early return and the normal payload) must carry it.
  const carried = (SRC.match(/degradations: state\.degradations \|\| \[\]/g) || []).length
  assert.ok(
    carried >= 2,
    `both report payload paths must carry state.degradations (found ${carried}) — otherwise every disclosure writes to a field nothing reads`
  )
})

// ── 1. write-path evidence loss (appendObservations) ──────────────────────────
check('appendObservations discloses a failed observation write', () => {
  const fn = sliceFn('async function appendObservations', '\n/** Read a run')

  assert.ok(
    fn.includes('result.errors > 0'),
    'appendObservations must inspect the error count storeObservations returns, not ignore it'
  )
  assert.ok(
    fn.includes('recordDegradation('),
    'a failed observation write must be disclosed to the founder, not just logged'
  )
  assert.ok(
    fn.includes('result.firstError'),
    'the disclosure should carry the underlying cause, or it is not actionable'
  )
  // Stepped-only is deliberate: the monolith keeps rows in memory and analyses them anyway,
  // so THIS report is unaffected there. Pin it so the nuance is not "simplified" away.
  assert.ok(
    /result\.errors > 0 && ctx\.stepped/.test(fn),
    'the degradation is stepped-only — the monolith still has the rows in memory'
  )
})

// ── 2. analysis batch lost to a failed LLM call (stepAnalyze) ─────────────────
check('stepAnalyze discloses a batch that failed after retries', () => {
  const fn = sliceFn('async function stepAnalyze', '// ─── summary')

  const catchIdx = fn.indexOf('catch (err) {')
  assert.ok(catchIdx >= 0, 'stepAnalyze must catch a per-batch failure')

  // Deliberately not a brace-matching regex: `${a.cursor + 1}` inside the very log line this
  // checks for contains a literal `}` that a naive `[^}]*` stops on before reaching the
  // statement below it. Check ordered literals instead.
  const counterIdx = fn.indexOf('failedBatches++', catchIdx)
  assert.ok(
    counterIdx > catchIdx && counterIdx < catchIdx + 300,
    'a failed batch must increment a counter where it is caught, not just log and continue'
  )

  const guardIdx = fn.indexOf('if (failedBatches > 0)')
  assert.ok(guardIdx > counterIdx, 'stepAnalyze must check failedBatches after the retry loop')
  const degradeIdx = fn.indexOf('recordDegradation(', guardIdx)
  assert.ok(
    degradeIdx > guardIdx && degradeIdx < guardIdx + 100,
    'stepAnalyze must record a degradation when any batch failed'
  )
})

// ── 3. cross-run memory writes (stepPersist) ──────────────────────────────────
check('stepPersist discloses failed context-layer writes', () => {
  const fn = sliceFn('async function stepPersist', '\n// ─── registry')

  // These run after saveReport, so recordDegradation cannot reach the report row. The
  // disclosure has to go somewhere that outlives it — ctx.onProgress lands in
  // intelligence_jobs.progress.
  assert.ok(
    fn.includes('layerFailures'),
    'stepPersist must collect which context-layer writes failed, not discard each one inline'
  )
  assert.ok(
    /if \(layerFailures\.length > 0\)/.test(fn),
    'stepPersist must act on collected failures'
  )
  assert.ok(
    /if \(layerFailures\.length > 0\) \{[\s\S]{0,400}ctx\.onProgress/.test(fn),
    'the disclosure must reach job progress (ctx.onProgress) — recordDegradation cannot, '
    + 'because the report row is already written by then'
  )
  // The old failure mode, pinned so it cannot come back one .catch at a time.
  assert.ok(
    !fn.includes("console.warn('[DB]"),
    'context-layer failures must not fall back to a bare console.warn'
  )
  // Every one of the five writes must route through the collector.
  const routed = (fn.match(/noteFailure\(/g) || []).length
  assert.ok(
    routed >= 5,
    `all five context-layer writes must report through noteFailure (found ${routed})`
  )
})

// ── 4. live signals are queried by run_id, not job id ─────────────────────────
//
// Not a disclosure guard, but the same family: a failure that produced no error and no
// symptom except an always-empty panel. `structured_signals.run_id` is minted by
// generateRunId(); the job id is a different UUID. Querying by job id matched zero rows on
// every poll tick, and because the call is wrapped in its own try/catch as "cosmetic", it
// never surfaced. Pinned here because the wrong version cannot be told from the right one
// by looking at the screen — both render an empty panel while the run is still early.
//
// The poll itself is currently ABSENT: the main merge rewrote AnalyzingScreen without the
// live-signal panel, so there is no consumer to feed. This guard is therefore conditional —
// it does not demand the poll exist, but the moment one is reintroduced it must key on
// run_id. The server-side half (serializeJob exposing run_id) is asserted unconditionally,
// because that is what any future panel depends on and it is invisible from the UI.
check('live signals, if polled at all, are polled by run_id and never the job id', () => {
  const dash = fs.readFileSync(
    new URL('../src/components/IntelligenceDashboard.jsx', import.meta.url),
    'utf8'
  )
  const jobs = fs.readFileSync(
    new URL('../lib/_intelligenceJobs.js', import.meta.url),
    'utf8'
  )

  // Comments stripped first — the note explaining the poll's absence names getLiveSignals()
  // itself, and a scan that counts prose finds a call that is not there.
  const code = dash.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const polls = [...code.matchAll(/getLiveSignals\(\s*([^)]*?)\s*\)/g)].map(m => m[1])
  for (const arg of polls) {
    assert.equal(
      arg, 'job.run_id',
      `the live-signal poll passes "${arg}" — only job.run_id matches structured_signals.run_id `
      + '(getLiveSignals(activeJobId) is the original regression: zero rows, silently)'
    )
  }
  assert.ok(
    /run_id:\s*job\.step_outputs\?\.__control\?\.run_id/.test(jobs),
    'serializeJob must expose run_id, or the client has no way to ask for the right rows'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
