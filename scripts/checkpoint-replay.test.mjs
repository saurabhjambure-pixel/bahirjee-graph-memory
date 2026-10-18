/**
 * Checkpoint replay guards — the last Phase 0 success criterion in
 * the internal multi-agent plan §11.1:
 *
 *   "one job can be replayed from a checkpoint with no data corruption"
 *
 * Replay is the property everything downstream assumes. §6.6 needs it for debugging, §9.5
 * needs it for evaluation ("replay against frozen inputs" is meaningless if replay is not
 * faithful), and Phase 1's agent contracts are built on top of it. If it is broken, every
 * later phase inherits the flaw.
 *
 * ── What this file can and cannot prove ──────────────────────────────────────
 *
 * It does NOT run the worker. `runOneStep()` needs Supabase, a live job row and an HTTP
 * request to self-trigger, so exercising it here would mean mocking three systems and would
 * mostly test the mocks. Instead it splits the property in two:
 *
 *   1. REGISTRY-LEVEL behaviour, tested for real against the exported functions — resuming
 *      from an arbitrary checkpoint visits exactly the remaining steps, and pipeline state
 *      survives the JSON round-trip that a JSONB checkpoint puts it through.
 *
 *   2. WORKER-LEVEL invariants that live in lib/_intelligenceWorker.js, asserted against its
 *      source. These are the ones that have actually broken before.
 *
 * A genuine end-to-end replay (run a job, kill it mid-step, resume, diff the report) still
 * needs a live database and is not something a unit test can stand in for. That gap is
 * recorded in the plan rather than papered over here.
 *
 * Run: npm run test:replay
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  PIPELINE_STEPS,
  createPipelineState,
  nextPipelineStep,
  getPipelineStep,
} from '../src/services/intelligenceService.js'

const WORKER = fs.readFileSync(new URL('../lib/_intelligenceWorker.js', import.meta.url), 'utf8')
const OBS = fs.readFileSync(new URL('../src/services/observationService.js', import.meta.url), 'utf8')
const V14 = fs.readFileSync(
  new URL('../scripts/migrations/v14_stepped_pipeline.sql', import.meta.url),
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

console.log('\ncheckpoint replay')

// ── 1. resuming from any checkpoint visits exactly the remaining steps ────────

check('resuming from any step completes the remainder without repeating or skipping', () => {
  const all = PIPELINE_STEPS.map(s => s.name)

  all.forEach((resumeAt, idx) => {
    const visited = []
    let cur = resumeAt
    for (let i = 0; cur && i <= all.length; i++) {
      visited.push(cur)
      cur = nextPipelineStep(cur)
    }
    assert.equal(cur, null, `resume at "${resumeAt}" did not terminate`)
    assert.deepEqual(
      visited, all.slice(idx),
      `resume at "${resumeAt}" ran the wrong steps — a replay must not repeat completed work or skip pending work`
    )
  })
})

check('a deferred step resumes as itself, not as the next step', () => {
  // The worker computes `nextStep = defer ? stepName : nextPipelineStep(stepName)`. A
  // cursored step that runs out of invocation budget must come back to itself, or the
  // remainder of its cursor is silently dropped mid-run.
  assert.ok(
    /defer \? stepName : nextPipelineStep\(stepName\)/.test(WORKER),
    'the worker must re-enter a deferred step rather than advancing past it'
  )
})

// ── 2. state survives the JSONB round-trip a checkpoint imposes ──────────────

const roundTrip = (v) => JSON.parse(JSON.stringify(v))

check('a fresh pipeline state round-trips through JSON unchanged', () => {
  const state = createPipelineState({ company_name: 'Acme', key_competitors: ['A', 'B'] }, 'run-1')
  assert.deepEqual(roundTrip(state), state, 'createPipelineState output is not checkpoint-safe')
})

check('a mid-run state with cursors and degradations round-trips unchanged', () => {
  const state = createPipelineState({ company_name: 'Acme' }, 'run-2')
  // Shaped like a real mid-run checkpoint: cursored progress, accumulated findings, and the
  // degradation list the disclosure work writes into.
  state.search = { cursor: 3, phase: 'waves', candidates: [{ url: 'https://x.test', rank: 0 }] }
  state.analyze = { cursor: 2, order: ['a', 'b'], batches: [['a'], ['b']], signals: [], empty: false }
  state.news = { cursor: 1 }
  state.degradations = [{ step: 'Source watch', reason: 'x', impact: 'y', at: '2026-08-12T00:00:00.000Z' }]
  state.memory = { lookbackMonths: 12, previousSignalsTail: [] }

  assert.deepEqual(roundTrip(state), state, 'a populated state is not checkpoint-safe')
})

check('checkpoint-hostile values are not silently tolerated', () => {
  // Guards the guard: if this ever passes, the round-trip assertions above prove nothing.
  // JSON drops undefined, stringifies Dates, and empties Maps/Sets — any of which would
  // corrupt a resumed run without raising anything.
  const hostile = { when: new Date(0), seen: new Set([1]), index: new Map([['a', 1]]), missing: undefined }
  assert.notDeepEqual(roundTrip(hostile), hostile, 'JSON round-trip is not lossy?! rewrite these tests')
})

check('the worker clones the checkpoint with the same JSON semantics it persists under', () => {
  // deepClone must not be structuredClone: that preserves Maps/Dates in memory, so state
  // would survive the clone and then silently degrade on the way into JSONB — the worst
  // case, because it only breaks after a re-trigger.
  assert.ok(
    /function deepClone\([^)]*\)\s*\{\s*return[^}]*JSON\.parse\(JSON\.stringify\(/s.test(WORKER),
    'deepClone must round-trip through JSON so in-memory state cannot outlive what JSONB can store'
  )
})

// ── 3. replayed writes are idempotent ────────────────────────────────────────

check('observation writes are upserted on the key the unique index enforces', () => {
  // A step can crash after writing and be replayed by the next invocation. Without this the
  // replay duplicates evidence, which inflates source counts and skews the verifier's
  // domain-share thresholds — corruption that looks like a successful run.
  assert.ok(/onConflict:\s*'run_id,source_url,source_type'/.test(OBS), 'observation upsert must target the unique key')
  assert.ok(/ignoreDuplicates:\s*true/.test(OBS), 'a replayed write must ignore duplicates, not error or overwrite')
  assert.ok(
    /CREATE UNIQUE INDEX[^;]*uq_observations_run_url_type[^;]*\(\s*run_id,\s*source_url,\s*source_type\s*\)/is.test(V14),
    'the onConflict target must be backed by a real unique index, or upsert silently degrades to insert'
  )
})

check('run_id is carried across invocations, not regenerated', () => {
  // If each invocation minted a fresh runId, the idempotency key above would change every
  // re-trigger and replay would duplicate everything it had already written.
  assert.ok(/run_id:\s*state\.runId/.test(WORKER), 'the checkpoint must persist the run id')
  // Not `createPipelineState\([^)]*control\.run_id`: the real call passes
  // `deepClone(job.context_payload) || {}` as the first argument, so a `[^)]*` class stops at
  // the inner `)` and never reaches the second argument. That char-class habit has now
  // produced three false results against this codebase (here, and twice in
  // degradation-disclosure.test.mjs) — its nested calls and `${...}` template literals defeat
  // it. Match across a bounded window instead.
  assert.ok(
    /createPipelineState\([\s\S]{0,160}?control\.run_id/.test(WORKER),
    'a resumed run must rehydrate its run id from the checkpoint rather than generating a new one'
  )
})

// ── 4. the loop is bounded, and forward progress is detectable ────────────────

check('every cursored step contributes to the forward-progress fingerprint', () => {
  // THE regression this file exists for. The guard aborts a run when a deferred step leaves
  // the fingerprint unchanged. A cursored step missing from the fingerprint therefore either
  // spuriously aborts a healthy run or spins to MAX_RETRIGGERS — and on `main` exactly that
  // happened when `verify` was cursored but absent here.
  const m = /const cursorOf = \(s\) =>([\s\S]*?);\n/.exec(WORKER)
  assert.ok(m, 'cursorOf not found in the worker — has the forward-progress guard moved?')
  const expr = m[1]

  const cursored = PIPELINE_STEPS.filter(s => s.cursored).map(s => s.name)
  assert.ok(cursored.length > 0, 'no cursored steps found — is the registry loaded?')

  const missing = cursored.filter(name => !new RegExp(`s\\.${name}\\?`).test(expr))
  assert.deepEqual(
    missing, [],
    `cursored step(s) missing from the forward-progress fingerprint: ${missing.join(', ')}. `
    + 'A deferring step that moves no watched cursor aborts the run.'
  )
})

check('the re-trigger loop is bounded', () => {
  assert.ok(/const MAX_RETRIGGERS = \d+/.test(WORKER), 'MAX_RETRIGGERS must be defined')
  assert.ok(
    /retriggerCount > MAX_RETRIGGERS/.test(WORKER),
    'the worker must abort once the re-trigger ceiling is passed'
  )
  assert.ok(
    /if \(defer && cursorBefore === cursorAfter\)/.test(WORKER),
    'the forward-progress guard must compare the fingerprint before and after the step'
  )
})

check('every registry step is reachable by name from a checkpoint', () => {
  // The checkpoint stores a step NAME. A resumed job looks it up; an unresolvable name is
  // the "Unknown pipeline step" failure a renamed step causes mid-flight (§4.1).
  for (const s of PIPELINE_STEPS) {
    assert.ok(getPipelineStep(s.name), `checkpointed name "${s.name}" does not resolve`)
  }
  // And an unresolvable name must fail loudly rather than being treated as "nothing to do",
  // which would complete a job having silently skipped the rest of the pipeline.
  assert.ok(
    /Unknown pipeline step/.test(WORKER),
    'the worker must throw on a checkpointed step name it cannot resolve'
  )
})

// ── 5. concurrent checkpoint writes must not clobber each other ──────────────
//
// §7.1's stated prerequisite for fan-out, and a live risk before it: `step_outputs` is one
// JSONB column updated read-modify-write, so a plain `.eq('id', jobId)` write is a blind
// overwrite — whichever invocation finishes LAST wins and the other's steps vanish with no
// error. The job lock makes that unlikely, not impossible: a worker that stops heartbeating
// while still running can be taken over by claimIntelligenceJob's stale-lock path.

check('the checkpoint write is a compare-and-set, not a blind overwrite', () => {
  const jobs = fs.readFileSync(new URL('../lib/_intelligenceJobs.js', import.meta.url), 'utf8')

  assert.match(jobs, /CheckpointConflictError/,
    'a lost checkpoint write must be distinguishable from a database error')
  assert.match(jobs, /step_outputs->__control->>retrigger_count/,
    'the write must be guarded on the checkpoint version it was based on')
  // maybeSingle, not single: zero rows IS the conflict, and .single() would surface it as an
  // opaque PostgREST error instead.
  assert.match(jobs, /maybeSingle\(\)/,
    'zero rows is the conflict case and must be detectable, not thrown as a row-count error')
  assert.match(jobs, /if \(!data\) throw new CheckpointConflictError/,
    'no matching row means someone else advanced the checkpoint')
})

check('the worker guards on the retrigger_count it started from', () => {
  const worker = fs.readFileSync(new URL('../lib/_intelligenceWorker.js', import.meta.url), 'utf8')
  assert.match(worker, /expectedRetriggerCount:\s*control\.retrigger_count/,
    'the guard must use the value READ at the start of the invocation, not the incremented one')
})

check('a checkpoint conflict does not fail the job', () => {
  const worker = fs.readFileSync(new URL('../lib/_intelligenceWorker.js', import.meta.url), 'utf8')
  const idx = worker.indexOf('instanceof CheckpointConflictError')
  assert.ok(idx > 0, 'the worker must handle a conflict distinctly')
  // The property is ORDERING, not absence: the conflict branch must `return` before control
  // can reach failIntelligenceJob. A fixed char-window check fails here for the wrong reason —
  // the normal failure path sits a few lines below the early return and lands inside the
  // window while being unreachable from this branch.
  const after = worker.slice(idx)
  const returnIdx = after.indexOf('return await getIntelligenceJob')
  const failIdx = after.indexOf('failIntelligenceJob')
  assert.ok(returnIdx > 0, 'the losing invocation should return the job as-is and stop')
  assert.ok(
    returnIdx < failIdx || failIdx === -1,
    'a conflict means another worker owns the job — the branch must return before any path '
    + 'that fails the job, or a benign race becomes a dead run'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
