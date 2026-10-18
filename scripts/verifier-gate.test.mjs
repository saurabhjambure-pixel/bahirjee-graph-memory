/**
 * Verifier gate guards — Phase 3's success criterion in
 * the internal multi-agent plan §11.5: "unsupported claims are blocked before
 * report save."
 *
 * That criterion was NOT met until 2026-08-12. `resolveVerifierMode()` defaulted to `report`,
 * where `persistedSignals = originalSignals` — the gate computed a verdict, announced that
 * signals "would be dropped under enforce", and then persisted every one of them. The call
 * site's comment asserted the opposite ("so an unsupported claim is never persisted"), which
 * was false for every run ever made.
 *
 * That is the same defect shape as the other four this runtime has produced — a declaration
 * whose consuming side is missing or fail-soft (§0.2). The difference is that this one
 * shipped unsupported claims to founders.
 *
 * Measured before flipping the default, over 49 real reports / 997 signals: 3.8% dropped, all
 * ungrounded; two reports emptied entirely, both holding exactly two unsupported claims.
 *
 * These assertions run the real policy — no source-grepping — because a gate asserted by
 * grep is exactly what let the old default survive review.
 *
 * Run: npm run test:verifier
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReport, resolveVerifierMode, VERIFIER_THRESHOLDS } from '../src/services/agents/policies/verifierPolicy.js'
import { filterGroundedSignals } from '../src/services/intelligenceService.js'
import { __columnCache } from '../src/services/reportService.js'
import { getAgent } from '../src/services/agents/registry.js'
import { PIPELINE_STEPS, stepVerify } from '../src/services/intelligenceService.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn(); passed++; console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn(); passed++; console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1
  }
}

console.log('\nverifier gate')

const grounded = (n, url) => ({ signal_headline: `Grounded finding ${n}`, the_move: `move ${n}`, source_url: url })
const ungrounded = (n) => ({ signal_headline: `Unsupported claim ${n}`, the_move: `move ${n}` })

// ── the gate must actually gate ───────────────────────────────────────────────

check('the default mode is enforce, and an unknown value fails closed to it', () => {
  assert.equal(resolveVerifierMode({}), 'enforce', 'the gate must gate by default')
  assert.equal(resolveVerifierMode({ VERIFIER_MODE: 'banana' }), 'enforce', 'an unrecognised mode must fail closed')
  assert.equal(resolveVerifierMode({ VERIFIER_MODE: 'report' }), 'report')
  assert.equal(resolveVerifierMode({ VERIFIER_MODE: 'off' }), 'off')
})

check('ungrounded signals are removed before persistence under the default mode', () => {
  const report = {
    signals: [grounded(1, 'https://a.test/x'), ungrounded(2), grounded(3, 'https://b.test/y'), ungrounded(4)],
  }
  const v = verifyReport(report, { mode: resolveVerifierMode({}) })

  assert.equal(v.changed, true, 'the gate must report that it changed the signal set')
  assert.equal(v.signals.length, 2, 'both unsupported claims must be dropped')
  assert.ok(
    v.signals.every(s => s.source_url),
    'every persisted signal must carry a source — that is what "unsupported" means here'
  )
  assert.equal(v.report.counts.dropped, 2)
  assert.equal(v.report.counts.signals_out, 2)
  assert.equal(v.report.verdict, 'blocked')
})

check('report mode measures without acting — and says so', () => {
  // Retained deliberately: it is how a threshold change gets measured before adoption. The
  // bug was it being the DEFAULT, not it existing.
  const report = { signals: [grounded(1, 'https://a.test/x'), ungrounded(2)] }
  const v = verifyReport(report, { mode: 'report' })

  assert.equal(v.changed, false, 'report mode must not alter the signal set')
  assert.equal(v.signals.length, 2, 'report mode persists everything, including the unsupported')
  assert.equal(v.report.counts.dropped, 0)
  assert.ok(
    v.report.actions.some(a => /would be dropped under enforce/.test(a)),
    'report mode must state what enforce would have done, or it is silently permissive'
  )
})

check('a report whose findings are all unsupported is emptied, not padded', () => {
  // The measured edge case: two historical reports go 2 → 0. Emptying is correct; the
  // disclosure in stepPersist is what makes it honest.
  const v = verifyReport({ signals: [ungrounded(1), ungrounded(2)] }, { mode: 'enforce' })
  assert.equal(v.signals.length, 0, 'unsupported claims must not survive merely because nothing else did')
  assert.equal(v.report.counts.signals_out, 0)
  assert.equal(v.report.verdict, 'blocked')
})

check('duplicate findings from the same source are collapsed', () => {
  const dupe = { signal_headline: 'Zoho reaches one million customers', the_move: 'milestone', source_url: 'https://a.test/x' }
  const v = verifyReport({ signals: [dupe, { ...dupe }, grounded(9, 'https://b.test/y')] }, { mode: 'enforce' })
  assert.ok(v.signals.length < 3, 'the same event from the same URL twice is one finding, not two')
})

check('a fully grounded report passes untouched', () => {
  const signals = [grounded(1, 'https://a.test/x'), grounded(2, 'https://b.test/y'), grounded(3, 'https://c.test/z')]
  const v = verifyReport({ signals }, { mode: 'enforce' })
  assert.equal(v.changed, false, 'a clean report must not be altered')
  assert.equal(v.signals.length, 3)
  assert.equal(v.report.counts.dropped, 0)
})

check('off mode disables the gate entirely', () => {
  assert.equal(resolveVerifierMode({ VERIFIER_MODE: 'off' }), 'off')
})

// ── the verdict must be reportable ───────────────────────────────────────────

check('the verdict carries a policy version and per-gate detail', () => {
  const v = verifyReport({ signals: [grounded(1, 'https://a.test/x'), ungrounded(2)] }, { mode: 'enforce' })
  assert.ok(v.report.policy_version, 'a verdict without a policy version cannot be attributed to a rule set')
  assert.ok(Array.isArray(v.report.gates) && v.report.gates.length > 0, 'the verdict must name which gates ran')
  const grounding = v.report.gates.find(g => g.id === 'signal_grounding')
  assert.ok(grounding, 'the grounding gate must always be evaluated')
  assert.equal(grounding.status, 'fail', 'an ungrounded signal must fail the grounding gate')
  assert.ok(Array.isArray(grounding.affected) && grounding.affected.length > 0,
    'the gate must name what it acted on, or the drop is unauditable')
})

check('empty and malformed input do not throw', () => {
  for (const input of [{}, { signals: [] }, { signals: null }, null]) {
    assert.doesNotThrow(() => verifyReport(input, { mode: 'enforce' }), `threw on ${JSON.stringify(input)}`)
  }
  assert.equal(verifyReport({ signals: [] }, { mode: 'enforce' }).signals.length, 0)
})

// ── citation precision: a fabricated path must not be presented as a citation ──
//
// The hole: grounding fell back to "does this DOMAIN appear in the evidence", so any path on
// a legitimate domain passed. A live run cited `…-in-indien` where the evidence held
// `…-in-india` — the model mutated the slug, the domain matched, and the founder got a 404 on
// a credible-looking finding. A fabricated citation is worse than a missing one: it looks
// verifiable.

check('an exact citation is kept as cited', () => {
  const obs = [{ url: 'https://example.com/guidelines-in-india' }]
  const out = filterGroundedSignals(
    [{ signal_headline: 'x', source_url: 'https://example.com/guidelines-in-india', date: '2026-01-01' }], '', obs)
  assert.equal(out.length, 1)
  assert.equal(out[0].source_confidence, 'exact')
  assert.equal(out[0].source_url, 'https://example.com/guidelines-in-india')
  assert.equal(out[0].cited_url, undefined, 'an exact match needs no audit trail')
})

check('URL matching ignores scheme case, www, trailing slash and fragment', () => {
  // All four are the same page. The first version of this fix dropped the uppercase one,
  // because `startsWith('http')` is false for 'HTTPS://' — caught by probing it.
  const obs = [{ url: 'https://example.com/guidelines-in-india' }]
  const variants = [
    'https://example.com/guidelines-in-india',
    'HTTPS://WWW.Example.com/guidelines-in-india/',
    'example.com/guidelines-in-india',
    'https://example.com/guidelines-in-india#section-2',
  ]
  for (const v of variants) {
    const out = filterGroundedSignals([{ signal_headline: 'x', source_url: v, date: '2026-01-01' }], '', obs)
    assert.equal(out.length, 1, `"${v}" was dropped`)
    assert.equal(out[0].source_confidence, 'exact', `"${v}" did not match exactly`)
  }
})

check('a fabricated path on a real domain is never cited as-is', () => {
  const obs = [{ url: 'https://example.com/guidelines-in-india' }]
  const out = filterGroundedSignals(
    [{ signal_headline: 'mangled', source_url: 'https://example.com/guidelines-in-indien', date: '2026-01-01' }], '', obs)

  assert.equal(out.length, 1, 'the finding itself may still be real — it is the citation that is wrong')
  assert.equal(out[0].source_confidence, 'domain_only')
  assert.notEqual(out[0].source_url, 'https://example.com/guidelines-in-indien',
    'the fabricated URL must not survive as the citation — that is the 404 the founder clicks')
  assert.equal(out[0].source_url, 'https://example.com/guidelines-in-india',
    'one source on that domain is unambiguous, so the link should point at it')
  assert.equal(out[0].cited_url, 'https://example.com/guidelines-in-indien',
    'what the model actually claimed must be preserved for audit')
})

check('an ambiguous domain resolves to the domain, not a guessed article', () => {
  const obs = [{ url: 'https://news.test/a' }, { url: 'https://news.test/b' }]
  const out = filterGroundedSignals(
    [{ signal_headline: 'x', source_url: 'https://news.test/invented', date: '2026-01-01' }], '', obs)
  assert.equal(out[0].source_confidence, 'domain_only')
  assert.equal(out[0].source_url, 'https://news.test',
    'with two candidates we cannot tell which was meant — guessing would attach the wrong article')
})

check('a citation to a domain never seen is still dropped', () => {
  const obs = [{ url: 'https://example.com/a' }]
  const out = filterGroundedSignals(
    [{ signal_headline: 'x', source_url: 'https://nowhere.test/x', date: '2026-01-01' }], '', obs)
  assert.deepEqual(out, [], 'an unseen domain is unsupported, as before')
})

check('observations are authoritative over the rendered batch text', () => {
  // Substring-matching prose is what made the old check permissive. A URL that appears only
  // as text, with no observation behind it, must not ground a signal.
  const text = 'see https://example.com/guidelines-in-india for details'
  const out = filterGroundedSignals(
    [{ signal_headline: 'x', source_url: 'https://example.com/guidelines-in-india', date: '2026-01-01' }],
    text, [{ url: 'https://different.test/z' }])
  assert.deepEqual(out, [], 'when observations are supplied they decide grounding, not the prose')
})

check('the verifier reports the domain-only rate so it can be measured', () => {
  const signals = [
    { signal_headline: 'a', source_url: 'https://x.test/1', source_confidence: 'exact' },
    { signal_headline: 'b', source_url: 'https://y.test', source_confidence: 'domain_only' },
  ]
  const v = verifyReport({ signals }, { mode: 'enforce' })
  const gate = v.report.gates.find(g => g.id === 'citation_precision')
  assert.ok(gate, 'citation_precision must always be evaluated')
  assert.equal(gate.status, 'warn', 'a domain-only citation is weaker evidence and must be flagged')
  assert.equal(gate.domain_only_ratio, 0.5)
  // Warn, not fail: whether to drop these is a decision for real numbers, the way the
  // enforce-by-default flip was measured over 49 reports first.
  assert.equal(v.signals.length, 2, 'domain-only signals are measured, not yet dropped')
})

// ── persist must be idempotent on replay ──────────────────────────────────────
//
// `saveReport()` was a plain INSERT. stepPersist calls it, and only afterwards does
// runOneStep() reach completeIntelligenceJob() — an invocation dying between those two leaves
// the report written and the checkpoint still saying `persist`, so the next invocation
// re-runs the step and inserts again. Demonstrated live on 2026-08-12: one report became two,
// with `intelligence_jobs.report_id` referencing only one and the other orphaned in the
// founder's history.
//
// Observations have had this property since v14 (uq_observations_run_url_type); reports had
// not. These assertions pin the fix in the only way a unit test can — by checking the code's
// conflict target against the migration that must satisfy it.

check('saveReport upserts on run_id rather than blind-inserting', () => {
  const src = readFileSync(new URL('../src/services/reportService.js', import.meta.url), 'utf8')
  assert.match(src, /onConflict:\s*'run_id'/, 'a replayed persist must update its own report, not insert a second')
  assert.match(src, /runId/, 'saveReport must accept the run id to key on')
  // Assert the BEHAVIOUR, not the mechanism: this previously matched the `hasRunId` latch
  // variable and broke when that was replaced by an expiring cache, flagging a refactor as a
  // regression. What must hold is that a missing column degrades instead of losing the report.
  // Behaviour, via the cache seam — the per-column `markColumnMissing('run_id', …)` call
  // this used to grep for is gone: the main merge brought five more optional columns and
  // the hand-enumerated retries became one loop over them. What must still hold is that
  // run_id is one of the columns that can be dropped, so a database without v18 degrades
  // instead of losing the report.
  __columnCache.reset()
  assert.equal(__columnCache.isAvailable('run_id'), true, 'run_id starts available')
  __columnCache.markMissing('run_id', '')
  assert.equal(__columnCache.isAvailable('run_id'), false,
    'a database without v18 must still save the report — degrade, do not lose it')
  __columnCache.reset()

  // And the degraded path must re-issue the write, not give up on it. Bounded window, NOT
  // `[^)]*`: these calls span lines and nest columnAvailable(...), so a char class stops at
  // the inner paren — a habit that has produced a false result four times here.
  assert.match(src, /markColumnMissing\(missing[\s\S]{0,600}?await insertReport\(\)/,
    'the degraded path must retry the write without the column')
})

check('every optional column is droppable AND re-probed — none may latch off forever', () => {
  // The main merge added degradations/report_kind/decision_*. A column that saveReport
  // writes but columnState does not track cannot be dropped at all: the PGRST204 loop
  // would spin on it. One that is tracked but never re-probed is the original silent bug.
  const src = readFileSync(new URL('../src/services/reportService.js', import.meta.url), 'utf8')
  // Scoped to the optionalValues literal — basePayload sits at the same indent, and its
  // columns are NOT optional (a missing website_url is a broken schema, not a migration).
  const literal = /const optionalValues = \{([\s\S]*?)\n\s*\};/.exec(src)
  assert.ok(literal, 'optionalValues literal not found — update this scan')
  const optional = [...literal[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1])
  assert.ok(optional.includes('degradations'), 'optionalValues scan came back empty-handed')

  for (const col of [...optional, 'run_id', 'verification']) {
    __columnCache.reset()
    __columnCache.markMissing(col, '')
    assert.equal(__columnCache.isAvailable(col), false, `${col} is written but not droppable`)
    __columnCache.backdate(col, __columnCache.RECHECK_MS + 1000)
    assert.equal(__columnCache.isAvailable(col), true, `${col} never re-probes after its migration`)
  }
  __columnCache.reset()
})

check('stepPersist passes the run id through', () => {
  const src = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  assert.match(src, /runId:\s*state\.runId/,
    'the key must be state.runId — it is rehydrated from __control.run_id, so it survives a resume')
})

check('the reports conflict target is a plain unique index the code can infer', () => {
  // Same trap as agent_runs: v16 used an expression index and every ON CONFLICT against it
  // failed silently for months. A partial index would fail the same way.
  const dir = fileURLToPath(new URL('../scripts/migrations', import.meta.url))
  const files = readdirSync(dir).filter(f => f.endsWith('.sql'))
    .map(f => ({ f, v: Number(/^v(\d+)/.exec(f)?.[1] ?? -1) })).sort((a, b) => a.v - b.v)

  let index = null
  for (const { f } of files) {
    const sql = readFileSync(join(dir, f), 'utf8').split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    const m = /create\s+unique\s+index[^;]*uq_reports_run_id[^;]*?\(([^)]*)\)([^;]*);/is.exec(sql)
    if (m) index = { file: f, cols: m[1].trim(), tail: m[2] || '' }
  }
  assert.ok(index, 'no migration creates uq_reports_run_id — the upsert has no conflict target')
  assert.equal(index.cols, 'run_id', `${index.file} indexes (${index.cols}), but the code conflicts on run_id`)
  assert.ok(!/coalesce|lower\s*\(/i.test(index.cols), `${index.file} uses an expression index — not inferable from a column list`)
  assert.ok(!/\bwhere\b/i.test(index.tail), `${index.file} uses a PARTIAL index — not inferable from a column list either`)
})

// ── optional columns must heal after their migration is applied ───────────────
//
// These fallbacks used to be one-way latches: set false on the first PGRST204 and never
// re-checked. Across a migration that is silently wrong — a warm serverless instance that
// saved a report BEFORE v15/v18 keeps skipping the column afterwards for the life of the
// instance. The operator applies the migration, sees no error, and quietly gets no verdicts.
// Exactly the silent-degradation shape these fallbacks exist to prevent.

check('a missing optional column is re-probed after its TTL, not latched off forever', () => {
  // Behavioural, not source-shape: an earlier version of this guard asserted that
  // COLUMN_RECHECK_MS appeared in the file, and passed with the expiry stubbed to `if (false)`.
  __columnCache.reset()
  assert.equal(__columnCache.isAvailable('verification'), true, 'columns start available')

  __columnCache.markMissing('verification', '')
  assert.equal(__columnCache.isAvailable('verification'), false,
    'a column that just failed must be skipped on the next write')

  // Still inside the TTL — must stay off, or every save pays a failed insert.
  __columnCache.backdate('verification', __columnCache.RECHECK_MS - 1000)
  assert.equal(__columnCache.isAvailable('verification'), false,
    'the column must not be re-probed before the TTL elapses')

  // Past the TTL — must re-probe, so applying the migration heals a warm instance.
  __columnCache.backdate('verification', 2000)
  assert.equal(__columnCache.isAvailable('verification'), true,
    'after the TTL the column must be retried — otherwise a warm instance never sees the migration')

  // Independent per column.
  __columnCache.reset()
  __columnCache.markMissing('run_id', '')
  assert.equal(__columnCache.isAvailable('run_id'), false)
  assert.equal(__columnCache.isAvailable('verification'), true, 'one missing column must not disable the others')
  __columnCache.reset()
})

check('the one-way latches are gone from saveReport', () => {
  const src = readFileSync(new URL('../src/services/reportService.js', import.meta.url), 'utf8')
  assert.ok(!/let hasVerification\s*=/.test(src) && !/let hasRunId\s*=/.test(src),
    'a latch that never recovers reintroduces the silent post-migration degradation')
})

// ── §5.6: the agent that judges is not the agent that writes ─────────────────

check('verifier_agent owns `verify` and cannot persist a report', () => {
  const verifier = getAgent('verifier_agent')
  assert.ok(verifier, 'verifier_agent must exist — the split is the whole point of §5.6')
  assert.deepEqual(verifier.steps, ['verify'])

  // NOT asserted read-only: the coverage gap-fill re-runs retrieval and appends
  // observations, so a "no writes at all" contract would be false on contact with the code.
  // What must hold is that it holds no REPORT or MEMORY persistence.
  assert.deepEqual(verifier.artifact_types_emitted, ['verification_report'],
    'the verifier emits a verdict and nothing else')
  for (const t of ['report_payload', 'memory_update']) {
    assert.ok(!verifier.artifact_types_emitted.includes(t),
      `verifier_agent must not emit ${t} — a bug in the judge must not be able to publish`)
  }
})

check('synthesis_agent owns publication and declares the report artifacts', () => {
  const synth = getAgent('synthesis_agent')
  assert.ok(synth, 'synthesis_agent must exist')
  // `attest` joined between summary and interpret. It checks the brief this agent just
  // wrote, which looks like the writer judging itself — but agents must own contiguous
  // step ranges, so no other owner is structurally possible, and verifier_agent cannot
  // take it because `summary` sits between `verify` and `attest`.
  //
  // The separation that matters survives: `attest` runs a DETERMINISTIC policy
  // (policies/briefPolicy.js — no LLM, no network), it cannot talk itself into a pass, and
  // it never writes `state.verify.verdict`. The fail-closed guarantee still belongs
  // entirely to verifier_agent, whose verdict `persist` refuses to publish without.
  // `review` (Jev, advisory) follows attest for the same contiguity reason, and can never
  // block: it records hits and at most discloses them.
  assert.deepEqual(synth.steps, ['summary', 'attest', 'review', 'interpret', 'news', 'persist'])
  assert.ok(synth.artifact_types_emitted.includes('report_payload'))
  assert.ok(!synth.artifact_types_emitted.includes('verification_report'),
    'the writer must not also author the verdict it is judged by')
})

check('the merged verifier_synthesis_agent is gone', () => {
  assert.equal(getAgent('verifier_synthesis_agent'), null,
    'a single agent that both judges and publishes is the arrangement §5.6 rejects')
})

check('verify is ordered before synthesis, so the brief is written from gated signals', () => {
  const names = PIPELINE_STEPS.map(s => s.name)
  const verify = names.indexOf('verify')
  assert.ok(verify >= 0, '`verify` must exist as a step')
  for (const later of ['summary', 'interpret', 'news', 'persist']) {
    assert.ok(names.indexOf(later) > verify,
      `${later} must run after verify — it reads state.analyze.signals, and gating afterwards `
      + 'let the brief cite findings that never appeared in the published report')
  }
})

check('the grounding gate runs in verify, not in persist', () => {
  const src = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  const verifyStart = src.indexOf('export async function stepVerify')
  const verifyEnd = src.indexOf('async function stepSummary', verifyStart)
  const persistStart = src.indexOf('async function stepPersist')
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart && persistStart > 0, 'step boundaries not found')

  const verifyBody = src.slice(verifyStart, verifyEnd)
  const persistBody = src.slice(persistStart)

  assert.match(verifyBody, /runVerifierGate\(/, 'the grounding gate must run inside stepVerify')
  assert.ok(!/runVerifierGate\(/.test(persistBody),
    'the gate must NOT also run in persist — the judge and the writer are different agents')
})

check('persist fails closed without a verdict', () => {
  const src = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  const persistBody = src.slice(src.indexOf('async function stepPersist'))
  // persist reads the verdict through verificationForPersist(), which also carries the
  // attestation and the Jev record into the saved row. Follow the indirection: the builder
  // must read the verdict, never mint one, and hand back null when there is none.
  assert.match(persistBody, /const verification = verificationForPersist\(state\)/,
    'persist must read the verdict rather than producing one')
  const builder = src.slice(src.indexOf('export function verificationForPersist'), src.indexOf('/** Assemble the report object'))
  assert.match(builder, /state\?\.verify\?\.verdict/, 'the builder must read the verdict verify left behind')
  assert.match(builder, /if \(!verdict\) return null/, 'no verdict must stay no verdict — the throw below depends on it')
  // Assert the THROW, not just the message: changing `throw new Error(` to `console.warn(`
  // leaves the string intact, and an earlier version of this assertion passed with exactly
  // that mutation. Fail-closed is the property; the wording is not.
  assert.match(persistBody, /throw new Error\([\s\S]{0,80}Refusing to persist/,
    'a missing verdict must THROW — publishing anyway ships exactly what the gate removes')
  // And there must be no branch that publishes against a blocking verdict.
  assert.ok(!/verdict\s*===\s*'blocked'\s*\)\s*\{[\s\S]{0,200}continue/.test(persistBody),
    'there must be no override path — an override is a human action, not an agent decision')
})

// ── stepVerify must ALWAYS leave a verdict behind ─────────────────────────────
//
// The two checks above are source greps, and greps are what let this ship: stepVerify had
// two bare `return`s ahead of the gate — one for an empty analyse, one for coverage that
// came back clean — and both left `state.verify.verdict` unset. `persist` then failed
// closed on every run that reached it through either path, which meant the CLEANER the
// run, the more reliably it died: "Refusing to persist: no verification verdict for this
// run", after the full retrieval spend, with no report saved.
//
// So these run the real step. The property is unconditional: if stepVerify returns without
// asking to be deferred, a verdict exists.

/** A signal set with no coverage gaps at all — the path that used to return early. */
const cleanCoverageSignals = [
  { signal_headline: 'Demand up', the_move: 'm1', category: 'DemandSignal', source_url: 'https://a.test/1', source_class: 'news', date: '2026-07-01', date_confidence: 'high' },
  { signal_headline: 'Rival ships', the_move: 'm2', category: 'CompetitorLaunch', source_url: 'https://b.test/2', source_class: 'filing', date: '2026-07-02', date_confidence: 'high' },
  { signal_headline: 'Round closed', the_move: 'm3', category: 'FundingActivity', source_url: 'https://c.test/3', source_class: 'news', date: '2026-07-03', date_confidence: 'high' },
  { signal_headline: 'Partner named', the_move: 'm4', category: 'PartnershipSignal', source_url: 'https://d.test/4', source_class: 'review', date: '2026-07-04', date_confidence: 'high' },
]

/** No budget for a gap fill, and not stepped — so no network and no defer. */
const offlineCtx = (stepped = false) => ({
  stepped,
  onProgress: () => {},
  timer: { canAfford: () => false, logStep: () => {} },
})

await checkAsync('a clean-coverage run still gets a verdict', async () => {
  const state = { analyze: { signals: cleanCoverageSignals }, degradations: [] }
  const out = await stepVerify(state, offlineCtx())
  assert.ok(!out?.defer, 'a run with no gaps has nothing to defer for')
  assert.ok(state.verify?.verdict,
    'coverage came back clean and the gate was skipped — persist would refuse to save this run')
  assert.equal(state.verify.verdict.verdict, 'pass')
})

await checkAsync('a run with nothing to analyse still gets a verdict', async () => {
  const state = { analyze: { empty: true, signals: [] }, degradations: [] }
  await stepVerify(state, offlineCtx())
  assert.ok(state.verify?.verdict,
    'an empty run must record that there was nothing to gate, not skip the gate')
})

await checkAsync('a gap-filled run that could not afford the retry still gets a verdict', async () => {
  const state = { analyze: { signals: [cleanCoverageSignals[0]] }, degradations: [] }
  await stepVerify(state, offlineCtx())
  assert.ok(state.verify?.verdict, 'the coverage gap path must also reach the gate')
})

await checkAsync('deferring is the one exit allowed to skip the gate', async () => {
  const state = { analyze: { signals: [cleanCoverageSignals[0]] }, degradations: [] }
  const out = await stepVerify(state, offlineCtx(true))
  assert.equal(out?.defer, true, 'a stepped run with no budget must ask for another invocation')
  assert.equal(state.verify.deferCount, 1, 'the defer must be counted, or it is unbounded')
})

// ── no gate may report a result it did not compute ────────────────────────────
//
// `insight_grounding` (G6) read `reportData.brief.insights` and failed when insights rested
// on fewer than 3 grounded signals. It never did so once. `verify` runs BEFORE `summary` —
// deliberately, so the brief is written from gated signals — so the call site had no brief to
// pass, `insights` was always `[]`, and the gate short-circuited to `pass` on every report
// ever produced. It was removed on 2026-08-16 rather than re-checked after `summary`, because
// its fail condition is also a strict subset of `source_diversity`'s: duplicates only collapse
// onto a signal from the same domain, so distinct domains <= deduped count, and fewer than 3
// grounded signals ALWAYS trips MIN_UNIQUE_DOMAINS. A second pass would have annotated
// nothing the verdict does not already carry.
//
// `competitor_validation` (G5) was starved the same way — the call site passed no
// `trackedEntities` — and is now fed `state.context`.
//
// The structural assertions elsewhere in this file could not see any of it: a gate that
// reports `pass` is indistinguishable, by grep, from a gate that checked something. So these
// execute the policy, and the first one is general — it fails for ANY future gate that can
// only fail on inputs the pipeline does not supply.

/**
 * One fixture per way a report can be defective, each built from ONLY what stepVerify hands
 * the gate: signals, and context._trackedEntities. If a gate cannot be tripped by any of
 * these, it cannot be tripped in production either.
 */
const TRIP_FIXTURES = [
  {
    name: 'an unsupported claim',
    input: { signals: [grounded(1, 'https://a.test/x'), ungrounded(2)] },
  },
  {
    name: 'a citation to a domain rather than a page',
    input: { signals: [{ signal_headline: 'a', source_url: 'https://x.test/1', source_confidence: 'domain_only' }] },
  },
  {
    name: 'the same finding twice',
    input: { signals: [grounded(1, 'https://a.test/x'), grounded(1, 'https://a.test/x')] },
  },
  {
    name: 'a single-sourced report',
    input: { signals: [grounded(1, 'https://a.test/x'), grounded(2, 'https://a.test/y'), grounded(3, 'https://a.test/z')] },
  },
  {
    name: 'findings with no usable dates',
    input: { signals: [grounded(1, 'https://a.test/x'), grounded(2, 'https://b.test/y'), grounded(3, 'https://c.test/z')] },
  },
  {
    name: 'a tracked competitor with no evidence behind it',
    input: {
      signals: [grounded(1, 'https://a.test/x'), grounded(2, 'https://b.test/y'), grounded(3, 'https://c.test/z')],
      context: { _trackedEntities: [{ name: 'Umbrella Corp', category: 'competitor' }] },
    },
  },
]

check('every gate can actually fail — none reports a verdict it did not compute', () => {
  // The gate ids the policy claims to evaluate, taken from a live run rather than a list
  // maintained here, so a newly added gate is covered the moment it ships.
  const clean = [
    { signal_headline: 'a', the_move: 'm', source_url: 'https://a.test/1', date_confidence: 'high' },
    { signal_headline: 'b', the_move: 'm', source_url: 'https://b.test/2', date_confidence: 'high' },
    { signal_headline: 'c', the_move: 'm', source_url: 'https://c.test/3', date_confidence: 'high' },
  ]
  const baseline = verifyReport({ signals: clean }, { mode: 'enforce' })
  assert.equal(baseline.report.verdict, 'pass', 'the baseline fixture must itself be clean')

  const gateIds = baseline.report.gates.map(g => g.id)
  assert.ok(gateIds.length >= 5, 'the policy reported suspiciously few gates')

  const trippedBy = new Map()
  for (const { name, input } of TRIP_FIXTURES) {
    for (const g of verifyReport(input, { mode: 'enforce' }).report.gates) {
      if (g.status !== 'pass' && !trippedBy.has(g.id)) trippedBy.set(g.id, name)
    }
  }

  for (const id of gateIds) {
    assert.ok(
      trippedBy.has(id),
      `gate "${id}" cannot be made to fail by any defect the pipeline can actually present it `
      + 'with. Either it reads something the call site never supplies — which is how '
      + '`insight_grounding` reported `pass` on every report ever produced — or this fixture '
      + 'list needs the case that trips it. Do not add a gate that passes without checking.'
    )
  }
})

check('the dead insight gate is gone, threshold and all', () => {
  const v = verifyReport(
    { signals: [grounded(1, 'https://a.test/x')], brief: { insights: [{ text: 'a conclusion' }] } },
    { mode: 'enforce' }
  )
  assert.ok(!v.report.gates.some(g => g.id === 'insight_grounding'),
    'insight_grounding is back, and `verify` still runs before `summary` — it can only report `pass`')
  assert.ok(!('MIN_GROUNDED_SIGNALS_FOR_INSIGHTS' in VERIFIER_THRESHOLDS),
    'a threshold no gate reads is the next dead gate waiting to be written against it')
})

check('the verdict does not depend on a brief, because at verify time there is never one', () => {
  // The property that made G6 dead, pinned as a requirement rather than an accident: passing
  // a brief must change nothing. A gate that needs the written brief needs a pass that runs
  // after `summary` — this function is not it.
  const signals = [
    { signal_headline: 'a', the_move: 'm', source_url: 'https://a.test/1', date_confidence: 'high' },
    { signal_headline: 'b', the_move: 'm', source_url: 'https://b.test/2', date_confidence: 'high' },
  ]
  const without = verifyReport({ signals }, { mode: 'enforce' })
  const with_ = verifyReport(
    { signals, brief: { insights: Array.from({ length: 8 }, (_, i) => ({ text: `insight ${i}` })) } },
    { mode: 'enforce' }
  )
  assert.deepEqual(with_.report.gates, without.report.gates,
    'a gate is reading the brief — it will report `pass` forever, because summary runs later')
  assert.equal(with_.report.verdict, without.report.verdict)
})

check('what G6 guarded is still caught: a thin report never reads as clean', () => {
  // Every grounded count G6 would have failed on, at MAXIMUM source diversity — one distinct
  // domain per signal, the best case a report of that size can present. If even that is
  // flagged, every thinner arrangement is too, so removing G6 lost no coverage.
  for (let n = 0; n < VERIFIER_THRESHOLDS.MIN_UNIQUE_DOMAINS; n++) {
    const signals = Array.from({ length: n }, (_, i) => ({
      signal_headline: `finding ${i}`, the_move: `m${i}`,
      source_url: `https://d${i}.test/x`, date_confidence: 'high',
    }))
    const v = verifyReport({ signals }, { mode: 'enforce' })
    const diversity = v.report.gates.find(g => g.id === 'source_diversity')

    assert.notEqual(diversity.status, 'pass',
      `${n} grounded signal(s) on ${n} domain(s) read as adequately sourced — this is the `
      + 'evidence floor G6 was removed in favour of')
    assert.notEqual(v.report.verdict, 'pass',
      `a report resting on ${n} grounded signal(s) must not publish with a clean verdict`)
  }
})

await checkAsync('the real verify step flags a thin run — through the live call site', async () => {
  // End to end, not against verifyReport directly: this is the path that starved G6, so the
  // replacement coverage has to be asserted where the arguments are actually assembled.
  const thin = [
    { signal_headline: 'Only finding', the_move: 'm1', category: 'DemandSignal', source_url: 'https://a.test/1', source_class: 'news', date: '2026-07-01', date_confidence: 'high' },
    { signal_headline: 'Second finding', the_move: 'm2', category: 'CompetitorLaunch', source_url: 'https://b.test/2', source_class: 'news', date: '2026-07-02', date_confidence: 'high' },
  ]
  const state = { analyze: { signals: thin }, degradations: [] }
  await stepVerify(state, offlineCtx())

  const verdict = state.verify?.verdict
  assert.ok(verdict, 'the step must leave a verdict behind')
  assert.ok(!verdict.gates.some(g => g.id === 'insight_grounding'),
    'the removed gate must not reappear through the real path')
  assert.notEqual(verdict.verdict, 'pass',
    'two grounded signals is below the evidence floor — the founder must not be told this is clean')
})

await checkAsync('competitor_validation is fed its inputs by the real call site', async () => {
  // It read `trackedEntities` while stepVerify passed only `{ signals }`, so it reported
  // `pass` over an empty array exactly like G6. The fix is the argument list, so the
  // assertion has to run the step rather than the policy.
  const signals = [
    { signal_headline: 'Demand up', the_move: 'm1', category: 'DemandSignal', source_url: 'https://a.test/1', source_class: 'news', date: '2026-07-01', date_confidence: 'high' },
    { signal_headline: 'Rival ships', the_move: 'm2', category: 'CompetitorLaunch', source_url: 'https://b.test/2', source_class: 'filing', date: '2026-07-02', date_confidence: 'high' },
    { signal_headline: 'Round closed', the_move: 'm3', category: 'FundingActivity', source_url: 'https://c.test/3', source_class: 'news', date: '2026-07-03', date_confidence: 'high' },
    { signal_headline: 'Partner named', the_move: 'm4', category: 'PartnershipSignal', source_url: 'https://d.test/4', source_class: 'review', date: '2026-07-04', date_confidence: 'high' },
  ]
  const state = {
    analyze: { signals },
    context: { _trackedEntities: [{ name: 'Umbrella Corp', category: 'competitor' }] },
    degradations: [],
  }
  await stepVerify(state, offlineCtx())

  const gate = state.verify.verdict.gates.find(g => g.id === 'competitor_validation')
  assert.ok(gate, 'competitor_validation must be evaluated')
  assert.equal(gate.status, 'warn',
    'a tracked competitor with no evidence behind it must be flagged — if this says `pass`, '
    + 'the call site is starving the gate again')
  assert.deepEqual(gate.affected, ['Umbrella Corp'], 'the gate must name what it acted on')

  // Annotating, not blocking: MAX_UNVALIDATED_COMPETITOR_RATIO has never been scored against
  // a real report, because the gate was dead until now. Measure before it moves verdicts —
  // the same order the enforce-by-default flip and citation_precision were decided in.
  assert.equal(gate.blocking, false, 'an uncalibrated threshold must not move a verdict yet')
  assert.equal(state.verify.verdict.verdict, 'pass',
    'an advisory gate must not drag down an otherwise clean run')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
