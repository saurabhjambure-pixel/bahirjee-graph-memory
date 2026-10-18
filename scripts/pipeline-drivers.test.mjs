/**
 * Pipeline driver parity — §4.2 and the Phase 0 success criteria in
 * the internal multi-agent plan.
 *
 * There are two drivers over ONE registry:
 *
 *   stepped   runOneStep()   in lib/_intelligenceWorker.js  — one step per invocation
 *   monolith  runSignalGeneration()                          — every step in one invocation
 *
 * This is the weak form of duplication and it is fine, because neither driver reimplements a
 * step: both dispatch the same PIPELINE_STEPS entries. The monolith is not dead code and not
 * a browser path (nothing in src/components imports it) — it is the fallback for a hosting
 * tier whose functions are too short to run the stepped driver at all.
 *
 * The rule that keeps it safe, and what this file pins:
 *
 *   The registry owns correctness. A driver owns only invocation mechanics.
 *
 * Contracts, budgets, gates, artifact emission and version pinning belong to the step
 * functions. A driver may own only how much work fits in one invocation, checkpointing,
 * leases and re-triggering. Anything a driver owns exclusively is behaviour the OTHER driver
 * silently skips — and "silently" is the whole problem, because both drivers produce a
 * plausible-looking report either way.
 *
 * This matters more, not less, once the agent conversion starts: it is exactly the seam where
 * a second orchestrator gets built by accident (§14.7).
 *
 * Run: npm run test:drivers
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PIPELINE_STEPS, getPipelineStep, nextPipelineStep } from '../src/services/intelligenceService.js'
import { jobToStepContext } from '../lib/_intelligenceWorker.js'

const WORKER = fs.readFileSync(new URL('../lib/_intelligenceWorker.js', import.meta.url), 'utf8')
const SERVICE = fs.readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')

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

console.log('\npipeline drivers')

// ── the registry is well-formed ───────────────────────────────────────────────

check('every registry entry has a name, label and runnable step', () => {
  assert.ok(PIPELINE_STEPS.length > 0, 'PIPELINE_STEPS is empty')
  for (const step of PIPELINE_STEPS) {
    assert.ok(step.name, `a step is missing its name: ${JSON.stringify(step)}`)
    assert.ok(step.label, `step "${step.name}" is missing a label`)
    assert.equal(typeof step.run, 'function', `step "${step.name}" has no run()`)
  }
  const names = PIPELINE_STEPS.map(s => s.name)
  assert.equal(new Set(names).size, names.length, `duplicate step names: ${names.join(', ')}`)
})

check('nextPipelineStep walks the whole registry exactly once and terminates', () => {
  const order = []
  let cur = PIPELINE_STEPS[0].name
  // Bounded: a cycle must fail the assert below rather than hang the suite.
  for (let i = 0; cur && i <= PIPELINE_STEPS.length; i++) {
    order.push(cur)
    cur = nextPipelineStep(cur)
  }
  assert.equal(cur, null, 'the step chain did not terminate — is the list cyclic?')
  assert.deepEqual(order, PIPELINE_STEPS.map(s => s.name), 'traversal order diverges from the registry')
})

check('getPipelineStep resolves every registered name and rejects unknown ones', () => {
  for (const step of PIPELINE_STEPS) {
    assert.ok(getPipelineStep(step.name), `getPipelineStep("${step.name}") returned nothing`)
  }
  assert.equal(getPipelineStep('definitely_not_a_step'), null, 'unknown step names must resolve to null')
})

// ── both drivers go through the registry ──────────────────────────────────────

check('the stepped driver dispatches through the registry, not a private list', () => {
  assert.ok(
    /runPipelineStep\(/.test(WORKER),
    'lib/_intelligenceWorker.js must dispatch via runPipelineStep()'
  )
  assert.ok(
    /nextPipelineStep\(/.test(WORKER),
    'lib/_intelligenceWorker.js must advance via nextPipelineStep()'
  )
  // A hardcoded step list in the worker is the failure this guards: it would drift from the
  // registry the first time a step is added, and only one driver would notice.
  for (const step of PIPELINE_STEPS) {
    assert.ok(
      !new RegExp(`\\[\\s*'${step.name}'\\s*,`).test(WORKER),
      `the worker appears to hardcode a step list containing "${step.name}" — dispatch via the registry instead`
    )
  }
})

check('the monolith driver iterates the registry', () => {
  const fn = SERVICE.slice(
    SERVICE.indexOf('export async function runSignalGeneration'),
    SERVICE.indexOf('export async function askBahirjee')
  )
  assert.ok(fn.length > 0, 'runSignalGeneration not found — renamed or moved?')
  assert.ok(
    /for \(const step of PIPELINE_STEPS\)/.test(fn),
    'the monolith must loop PIPELINE_STEPS rather than calling steps by hand'
  )
  assert.ok(
    /step\.run\(state, ctx\)/.test(fn),
    'the monolith must invoke each registry entry’s own run()'
  )
})

// ── the driver contract: every ctx.job field a step reads must be supplied ────
//
// The stepped worker is the production driver. `jobToStepContext` is the one place that
// turns a DB job row into `ctx.job` for it — a field a step reads but this function never
// sets is not "untested", it is DEAD CODE in every real run: the read always resolves to
// undefined and nothing throws. This is exactly the failure shape the engineering notes names as the
// codebase's dominant risk (a column missing from a boundary, quietly worsening output).
// Derived from the source rather than hardcoded, so a step that starts reading a new
// ctx.job field without the worker supplying it fails this test immediately.

check('every ctx.job field a pipeline step reads is supplied by jobToStepContext', () => {
  const readFields = new Set(
    [...SERVICE.matchAll(/ctx\.job\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1])
  )
  assert.ok(readFields.size > 0, 'no ctx.job.<field> reads found in intelligenceService.js — did the pattern change?')

  const fnStart = WORKER.indexOf('function jobToStepContext')
  assert.notEqual(fnStart, -1, 'jobToStepContext not found in lib/_intelligenceWorker.js — repoint this test')
  const fnEnd = WORKER.indexOf('\n}\n', fnStart)
  assert.notEqual(fnEnd, -1, 'could not find the end of jobToStepContext')
  const fnBody = WORKER.slice(fnStart, fnEnd)

  const jobBlockMatch = fnBody.match(/job:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*onProgress,/)
  assert.ok(jobBlockMatch, 'could not isolate the `job: { ... }` object jobToStepContext returns — repoint this test')

  const suppliedFields = new Set(
    [...jobBlockMatch[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map(m => m[1])
  )

  const missing = [...readFields].filter(f => !suppliedFields.has(f)).sort()
  assert.deepEqual(
    missing, [],
    `pipeline steps read ctx.job.${missing.join(' / ctx.job.')} but jobToStepContext never ` +
    'supplies it. The stepped worker is the production driver, so this field is unreachable ' +
    'in every real run — see the productContext/targetId incident this test was added to catch.'
  )
})

// A mutation audit found the check above proves only that a KEY named "targetId" exists in
// the object jobToStepContext returns — never what it is bound TO. `targetId: null` (a
// literal, discarding the job row entirely) satisfies it exactly as well as the real
// `targetId: job.target_id || null`. That mutation is not hypothetical: it is what N1/T1
// names as unreachable-in-production risk for every field here, not only targetId — a
// pipeline step silently reading undefined/a wrong default for a field whose KEY is present
// but whose BINDING regressed. This calls the real, exported jobToStepContext with two
// fixture job rows and asserts every field of the real returned ctx.job — not a regex over
// the source — matching the engineering notes' own rule: pin the round trip, not just the write.
check('jobToStepContext binds every ctx.job field to its actual job-row source, not a stub', () => {
  // Fixture 1: every DB column present with its own distinguishable value, so a mutation
  // that swaps in a literal, a wrong column, or another field's value is caught directly —
  // and so the *_context/productContext PRIMARY sources are proven to win over their
  // fallback when both are present.
  const fullJob = {
    website_url: 'https://full.example.com',
    linkedin_url: 'https://linkedin.com/company/full',
    uploaded_doc_text: 'doc-text-full',
    created_by: 'user-full',
    client_id: 'client-full',
    requested_by_role: 'admin',
    analysis_mode: 'product',
    run_tier: 'shallow',
    decision_id: 'decision-full',
    decision_context: { raw_input: 'decision-full-primary' },
    target_id: 'target-full-123',
    step_outputs: {
      // Present on BOTH fixtures so fixture 1 proves decision_context wins over this
      // nested fallback when the primary column is also present.
      state: { context: { _decision: { raw_input: 'FALLBACK — must lose to decision_context' } } },
      job: { productContext: { target_id: 'target-full-123', name: 'Full Product' } }
    }
  }
  const ctxFull = jobToStepContext(fullJob, () => {}, {})

  assert.equal(ctxFull.job.websiteUrl, fullJob.website_url, 'websiteUrl must bind to job.website_url')
  assert.equal(ctxFull.job.linkedinUrl, fullJob.linkedin_url, 'linkedinUrl must bind to job.linkedin_url')
  assert.equal(ctxFull.job.uploadedDocText, fullJob.uploaded_doc_text, 'uploadedDocText must bind to job.uploaded_doc_text')
  assert.equal(ctxFull.job.userId, fullJob.created_by, 'userId must bind to job.created_by')
  assert.equal(ctxFull.job.clientId, fullJob.client_id, 'clientId must bind to job.client_id')
  assert.equal(ctxFull.job.requestedByRole, fullJob.requested_by_role, 'requestedByRole must bind to job.requested_by_role')
  assert.equal(ctxFull.job.analysisMode, fullJob.analysis_mode, 'analysisMode must bind to job.analysis_mode')
  assert.equal(ctxFull.job.runTier, fullJob.run_tier, 'runTier must bind to job.run_tier')
  assert.equal(ctxFull.job.decisionId, fullJob.decision_id, 'decisionId must bind to job.decision_id')
  assert.deepEqual(
    ctxFull.job.decisionContext, fullJob.decision_context,
    'decisionContext must prefer job.decision_context over the step_outputs fallback when both are present'
  )
  // The exact T1 mutation: `targetId: null` instead of `job.target_id || null`. With a
  // job row that HAS a target_id, that mutation returns null here and this line fails.
  assert.equal(ctxFull.job.targetId, fullJob.target_id, 'targetId must bind to job.target_id')
  assert.deepEqual(
    ctxFull.job.productContext, fullJob.step_outputs.job.productContext,
    'productContext must bind to job.step_outputs.job.productContext'
  )

  // Fixture 2: every optional/fallback field absent from the job row, proving the OR
  // defaults and the nested fallback paths — not just the primary bindings above.
  const sparseJob = {
    website_url: 'https://sparse.example.com',
    linkedin_url: null,
    created_by: 'user-sparse',
    client_id: 'client-sparse',
    step_outputs: {
      state: { context: { _decision: { raw_input: 'decision-from-fallback' } } },
      job: { productContext: { target_id: 'target-sparse', name: 'Sparse Product' } }
    }
  }
  const ctxSparse = jobToStepContext(sparseJob, () => {}, {})

  assert.equal(ctxSparse.job.uploadedDocText, null, 'a missing uploaded_doc_text must fall back to null, not undefined')
  assert.equal(ctxSparse.job.requestedByRole, 'client_user', "a missing requested_by_role must default to 'client_user'")
  assert.equal(ctxSparse.job.analysisMode, 'company', "a missing analysis_mode must default to 'company'")
  assert.equal(ctxSparse.job.runTier, 'full', "a missing run_tier must default to 'full'")
  assert.equal(ctxSparse.job.decisionId, null, 'a missing decision_id must fall back to null')
  assert.deepEqual(
    ctxSparse.job.decisionContext, sparseJob.step_outputs.state.context._decision,
    'decisionContext must fall back to step_outputs.state.context._decision when job.decision_context is absent'
  )
  // Not "some non-null value" — a job with no target_id at all must resolve to null, the
  // same value the mutation always returns, so this line alone cannot pass BOTH the
  // mutant and the real code; only the paired fixture-1 assertion above can, which is why
  // both fixtures are required.
  assert.equal(ctxSparse.job.targetId, null, 'a missing target_id must fall back to null')
  assert.deepEqual(
    ctxSparse.job.productContext, sparseJob.step_outputs.job.productContext,
    'productContext must bind to job.step_outputs.job.productContext'
  )

  // Fixture 3: no step_outputs at all — the optional-chaining fallbacks must degrade to
  // null rather than throw.
  const bareJob = { website_url: 'https://bare.example.com', created_by: 'u', client_id: 'c' }
  const ctxBare = jobToStepContext(bareJob, () => {}, {})
  assert.equal(ctxBare.job.decisionContext, null, 'no step_outputs must still resolve decisionContext to null')
  assert.equal(ctxBare.job.productContext, null, 'no step_outputs must still resolve productContext to null')
  assert.equal(ctxBare.job.targetId, null, 'no target_id must resolve to null')
})

// ── the monolith is a driver, not a browser path ──────────────────────────────

check('nothing in the browser bundle calls the monolith driver', () => {
  // Resolve against this module, not cwd — `npm run` sets cwd to the repo root today, but a
  // test that only passes from one directory is a test that will be "fixed" by deleting it.
  const COMPONENTS = fileURLToPath(new URL('../src/components', import.meta.url))
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (/\.jsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }
  const componentFiles = walk(COMPONENTS)
  assert.ok(componentFiles.length > 0, 'component scan found nothing — the walk is broken')

  const offenders = componentFiles.filter(f =>
    /runSignalGeneration\s*\(/.test(fs.readFileSync(f, 'utf8'))
  )
  assert.deepEqual(
    offenders, [],
    'a component calls runSignalGeneration() — the pipeline is server-owned; submit a job instead'
  )
})


// ─── competitor persistence must not override a human deletion ──────────────
//
// stepMemory merges the PREVIOUS run's key_competitors back into this run's context as
// "drift protection". That previous context still contains anything the founder deleted on
// the review screen moments earlier — so unfiltered, the merge re-adds it one step after
// the deletion, tagged `source: 'previous_run'`, and the correction can never stick across
// runs no matter how many times it is made.
//
// This lives in the drivers test because the merge is registry-owned behaviour that BOTH
// drivers run: a fix that only held in one of them would be exactly the silent divergence
// this file exists to prevent.

check('the competitor merge respects _userEdits.removed', () => {
  const start = SERVICE.indexOf('COMPETITOR PERSISTENCE')
  assert.notEqual(start, -1, 'the competitor-persistence block is gone — repoint this test')
  const block = SERVICE.slice(start, SERVICE.indexOf('state.memory = {', start))

  assert.match(
    block, /_userEdits\?\.removed/,
    'the merge must read contextJson._userEdits.removed. Without it, a competitor the ' +
    'founder deleted is silently restored from the previous run on the very next step.'
  )

  // The filter has to sit on prevCompetitors — filtering after the merge, or only the
  // current list, leaves the resurrected entry in place.
  assert.match(
    block, /const prevCompetitors[\s\S]*?\.filter\([\s\S]*?removedByUser\.has/,
    'the removal filter must be applied to prevCompetitors as it is built, not to the ' +
    'merged result — the previous run is the only place the deleted name comes from'
  )

  // Name comparison must be normalized on both sides, or "Delhivery" fails to match
  // "delhivery " and the guard passes while doing nothing.
  const filterFrom = block.slice(block.indexOf('const removedByUser'))
  assert.match(
    filterFrom, /toLowerCase\(\)\.trim\(\)/,
    'names must be lowercased and trimmed on both sides of the comparison, matching how ' +
    'the merge itself already keys existingNames'
  )
})

check('a run with no user edits still gets drift protection', () => {
  const start = SERVICE.indexOf('COMPETITOR PERSISTENCE')
  const block = SERVICE.slice(start, SERVICE.indexOf('state.memory = {', start))
  // The guard must degrade to a no-op, not to "skip the merge". Competitor drift between
  // runs is a real problem and this block is the only thing holding it.
  assert.match(
    block, /_userEdits\?\.removed \|\| \[\]/,
    'an absent _userEdits must yield an empty removal set, leaving the merge untouched'
  )
  assert.match(block, /if \(prevCompetitors\.length > 0\)/, 'the merge itself must still run')
})

// ─── a reused context skips the build in both drivers ───────────────────────

check('a job carrying a context starts at memory, not context', () => {
  // This is what makes context reuse cost nothing: the worker must not rebuild a context
  // the client already supplied. Both drivers gate on the same two job fields.
  const stepped = WORKER.slice(WORKER.indexOf('function initialStep'))
  assert.match(
    stepped.slice(0, 400), /!job\.context_payload \|\| job\.build_context_on_server/,
    'initialStep must skip the context step whenever a context payload is supplied'
  )
  assert.match(
    SERVICE, /FIRST_STEP_WITH_CONTEXT\s*=\s*'memory'/,
    'the monolith must agree with the stepped driver about where a supplied context resumes'
  )
})


// ─── the server context step ────────────────────────────────────────────────

check('stepContext reuses a stored context instead of rebuilding', () => {
  const start = SERVICE.indexOf('async function stepContext')
  assert.notEqual(start, -1, 'stepContext not found — repoint this test')
  const body = SERVICE.slice(start, SERVICE.indexOf('async function stepMemory', start))

  assert.match(
    body, /getCurrentCompanyContext/,
    'the server path must check for a stored context before paying for a full build'
  )
  assert.match(body, /hydrateStoredContext/, 'a reused context must be stripped of run-scoped keys')
  assert.match(
    body, /buildInitialContext/,
    'the fresh build must remain the fallback — a first run has nothing to reuse'
  )
  // The lookup must not be able to fail the run: a rebuild is a cost, a thrown step is an outage.
  assert.match(body, /\.catch\(/, 'a failed lookup must degrade to building, not throw')
})

check('an admin run pauses for review like everyone else', () => {
  const start = SERVICE.indexOf('async function stepContext')
  const body = SERVICE.slice(start, SERVICE.indexOf('async function stepMemory', start))

  assert.ok(
    !/requestedByRole === 'admin' \? \{\} :/.test(body),
    'admin runs must no longer skip the review pause — an admin was the one person who ' +
    'could not see or correct the context a run was about to be built on'
  )
  assert.match(body, /pause: 'awaiting_context_review'/, 'the step must still park the job')
})

check('the admin UI can actually answer that pause', () => {
  // Pausing a job with nothing to surface it is worse than not pausing: the run hangs and
  // the page spins until the tab is closed.
  const admin = fs.readFileSync(new URL('../src/pages/admin/ClientDetail.jsx', import.meta.url), 'utf8')
  assert.match(
    admin, /job\.status === 'awaiting_context_review'/,
    'ClientDetail must handle the review pause, or an admin run hangs forever'
  )
  assert.match(admin, /resumeIntelligenceJob/, 'it must be able to resume the parked job')
  assert.match(admin, /ContextReviewScreen/, 'it must render the context for review')
  // The poll returns without rescheduling when it parks, so resuming needs a dependency
  // that actually changes — re-setting activeJobId to itself is a no-op React bails out of.
  assert.match(
    admin, /\}, \[activeJobId, pollNonce\]\)/,
    'the poll effect must depend on something that changes when the job resumes'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
