/**
 * Golden cases — Phase 5's regression net (§9.5).
 *
 * ── Why this only covers the deterministic path ──────────────────────────────
 *
 * §9.5 asks for an evaluation harness that can detect quality regressions. The obvious
 * design — run the pipeline on a fixed company and diff the report — does not work here, and
 * the live replays proved it: two runs minutes apart on the same company shared **zero**
 * signal headlines. Queries are LLM-generated per run, so different queries reach different
 * sources and produce different findings. Baselining against live retrieval measures the
 * weather, not the code.
 *
 * So this harness freezes the inputs and pins only what is genuinely deterministic: the
 * quality chain that decides what survives.
 *
 *     filterSelfSignals → filterReadableSignals → filterGroundedSignals → verifyReport(gate)
 *                                                                      → verifyReport(coverage)
 *
 * Every one of those is pure. Together they are the whole answer to "what does the founder
 * actually see, and why is anything missing" — which is exactly what a quality regression
 * changes. The LLM's *choice* of findings is not pinned, because asserting that would be
 * asserting the model is deterministic.
 *
 * ── How to use it ────────────────────────────────────────────────────────────
 *
 * Each case in scripts/golden/cases/*.json carries frozen observations and signals, and a
 * `expected` block recorded from a known-good run. A behaviour change shows up as a diff.
 *
 *   npm run test:golden              — check against the recorded expectations
 *   UPDATE_GOLDEN=1 npm run test:golden — re-record them
 *
 * Re-recording is a deliberate act. If a diff appears, decide whether the new behaviour is
 * better BEFORE updating — an expectation updated reflexively is worse than no expectation,
 * because it converts a caught regression into a silent one.
 *
 * Run: npm run test:golden
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  filterGroundedSignals, filterReadableSignals, filterSelfSignals, planAnalyzeBatches,
} from '../src/services/intelligenceService.js'
import { verifyReport as runGate, resolveVerifierMode, VERIFIER_POLICY_VERSION } from '../src/services/agents/policies/verifierPolicy.js'
import { verifyReport as runCoverage } from '../src/services/reportVerifier.js'

const CASES_DIR = fileURLToPath(new URL('./golden/cases', import.meta.url))
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let passed = 0
let updated = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

/**
 * Run the deterministic quality chain over one frozen case.
 * Mirrors the real order: self → readable → grounded → gate. Coverage is scored on the
 * survivors, which is where stepVerify scores it too.
 */
function evaluate(c) {
  const obs = c.observations || []
  const afterSelf = filterSelfSignals(c.signals || [], c.company || '')
  const afterReadable = filterReadableSignals(afterSelf)
  const afterGrounded = filterGroundedSignals(afterReadable, '', obs)

  const gate = runGate({ signals: afterGrounded }, { mode: resolveVerifierMode({}) })
  const coverage = runCoverage(gate.signals)

  const hosts = new Set()
  for (const s of gate.signals) {
    try { hosts.add(new URL(s.source_url).hostname.replace(/^www\./, '')) } catch { /* skip */ }
  }
  const confidence = {}
  for (const s of gate.signals) {
    const k = s.source_confidence || '(none)'
    confidence[k] = (confidence[k] || 0) + 1
  }

  return {
    // Funnel — where findings are lost, and to which rule.
    signals_in: (c.signals || []).length,
    dropped_self: (c.signals || []).length - afterSelf.length,
    dropped_unreadable: afterSelf.length - afterReadable.length,
    dropped_ungrounded_prefilter: afterReadable.length - afterGrounded.length,
    dropped_by_gate: gate.report.counts.dropped,
    published: gate.signals.length,

    // What the founder ends up looking at.
    verdict: gate.report.verdict,
    source_confidence: confidence,
    distinct_source_hosts: hosts.size,
    sections: [...new Set(gate.signals.map(s => s.category).filter(Boolean))].sort(),
    headlines: gate.signals.map(s => s.signal_headline).sort(),

    // The URLs the founder would actually click. Recorded because the confidence COUNTS alone
    // miss a citation regression: reverting the repointing fix leaves a signal marked
    // `domain_only` while restoring the fabricated link, which every other field here reports
    // as unchanged. The first version of this harness had exactly that blind spot.
    citations: gate.signals.map(s => s.source_url).sort(),
    // What the model originally claimed, where it differed from what we publish.
    repointed_from: gate.signals.filter(s => s.cited_url).map(s => s.cited_url).sort(),

    // Which rules fired, and what the founder is told is missing.
    failed_gates: gate.report.gates.filter(g => g.status !== 'pass').map(g => `${g.id}:${g.status}`).sort(),
    coverage_ok: coverage.ok,
    coverage_gaps: (coverage.gaps || []).map(g => g.section || 'general').sort(),
  }
}

console.log(`\ngolden cases${UPDATE ? '  (RE-RECORDING)' : ''}`)

const files = readdirSync(CASES_DIR).filter(f => f.endsWith('.json')).sort()
assert.ok(files.length > 0, 'no golden cases found')

for (const file of files) {
  const path = join(CASES_DIR, file)
  const c = JSON.parse(readFileSync(path, 'utf8'))
  const actual = evaluate(c)

  if (UPDATE) {
    writeFileSync(path, JSON.stringify({ ...c, expected: actual }, null, 2) + '\n')
    updated++
    console.log(`  ↻ ${c.name} re-recorded`)
    continue
  }

  check(`${c.name}: ${c.why.slice(0, 70)}…`, () => {
    assert.ok(c.expected, `${c.name} has no recorded expectation — run UPDATE_GOLDEN=1 npm run test:golden`)
    assert.deepEqual(actual, c.expected,
      `${c.name} changed.\n    Decide whether the new behaviour is BETTER before re-recording — `
      + 'an expectation updated reflexively turns a caught regression into a silent one.')
  })
}

// The policy version is part of the contract: a threshold change that does not bump it makes
// every recorded expectation unattributable to a rule set.
if (!UPDATE) {
  check('the verifier policy version is recorded alongside the expectations', () => {
    assert.ok(VERIFIER_POLICY_VERSION, 'verifierPolicy must expose a policy version')
    const meta = JSON.parse(readFileSync(join(CASES_DIR, '..', 'policy-version.json'), 'utf8'))
    assert.equal(
      meta.verifier_policy_version, VERIFIER_POLICY_VERSION,
      'the verifier policy changed without re-recording the golden cases. Bump deliberately: '
      + 'run UPDATE_GOLDEN=1 npm run test:golden and review every diff.'
    )
  })
}

if (UPDATE) {
  writeFileSync(
    join(CASES_DIR, '..', 'policy-version.json'),
    JSON.stringify({ verifier_policy_version: VERIFIER_POLICY_VERSION }, null, 2) + '\n'
  )
  console.log(`\n${updated} case(s) re-recorded. Review the diff before committing.\n`)
} else {
  // ── the observation chain, executed ──────────────────────────────────────────
//
// The golden cases above cover the SIGNAL chain. The OBSERVATION chain that feeds it —
// gating, dedupe, relevance filtering, the low-yield fallback, capObservations and batching —
// had no coverage at all, and it broke: a merge left `const scored` beside
// `scored = capObservations(scored)`, so every run died at `analyze` with "Assignment to
// constant variable" while seventeen suites stayed green. Nothing executed the function.
//
// These call it for real. A TypeError cannot hide behind a source assertion.

check('planAnalyzeBatches runs end to end and batches every gated observation', () => {
  const obs = Array.from({ length: 40 }, (_, i) => ({
    id: `o${i}`, url: `https://src${i % 7}.test/a${i}`,
    data: `TITLE: finding ${i}\nURL: https://src${i % 7}.test/a${i}\nCONTENT: ${'x'.repeat(600)}`,
    score: 0.9,
  }))
  const { order, batches, gatedCount } = planAnalyzeBatches(obs)

  assert.ok(gatedCount > 0, 'observations with real content must survive gating')
  assert.ok(batches.length > 0, 'gated observations must be batched')
  const batched = batches.flat()
  assert.equal(new Set(batched).size, batched.length, 'an observation must not appear in two batches')
  assert.ok(batched.every(id => order.includes(id)), 'every batched id must be in the planned order')
})

check('a run whose evidence all scores below the bar analyzes the best of it, not nothing', () => {
  // Every score below MIN_TAVILY_SCORE (0.15). The old fallback re-filtered at 0.15 — the
  // SAME constant — so it logged "lowering threshold to maximize yield" and changed nothing:
  // 20 gated observations produced 0 batches, an empty analysis with a log line claiming a
  // rescue. Verified against the live function before it was fixed.
  const weak = Array.from({ length: 20 }, (_, i) => ({
    id: `w${i}`, url: `https://w${i}.test/x`,
    data: `TITLE: weak ${i}\nURL: https://w${i}.test/x\nCONTENT: ${'y'.repeat(600)}`,
    score: 0.05 + i * 0.001,
  }))
  const { gatedCount, batches } = planAnalyzeBatches(weak)
  assert.ok(gatedCount > 0, 'gating is about content length, not score')
  assert.ok(batches.flat().length > 0,
    'weak-but-real evidence must be analyzed rather than silently producing an empty report')

  // Ranked, not re-thresholded: a second constant beside MIN_TAVILY_SCORE is what went stale.
  const svc = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  // Strip `//` comments first: the fix's own explanation quotes the old `fallbackScore = 0.15`
  // line, and matching prose made this assertion fail against correct code.
  const code = svc.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  assert.ok(!/const\s+fallbackScore\s*=/.test(code),
    'the fallback must not re-filter at a second constant that can drift out of step with the bar')
  assert.match(svc, /sort\(\(a, b\) => \(b\.score \?\? 1\) - \(a\.score \?\? 1\)\)/,
    'the fallback should rank by score so it cannot drift out of step with the bar')
})

check('null-scored observations survive the relevance gate', () => {
  // `?? 1` is load-bearing: deep reads and Exa rows carry a null score, and coercing to 0
  // would discard all of them.
  const nulls = Array.from({ length: 6 }, (_, i) => ({
    id: `n${i}`, url: `https://n${i}.test/x`,
    data: `TITLE: deep ${i}\nURL: https://n${i}.test/x\nCONTENT: ${'z'.repeat(600)}`,
    score: null, isDeepRead: true,
  }))
  assert.equal(planAnalyzeBatches(nulls).gatedCount, 6, 'a null score must not be read as zero relevance')
})

check('planAnalyzeBatches tolerates empty and thin input', () => {
  for (const input of [[], [{ id: 'x', url: 'https://a.test', data: 'too short' }]]) {
    assert.doesNotThrow(() => planAnalyzeBatches(input))
  }
  assert.equal(planAnalyzeBatches([]).gatedCount, 0)
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
}
