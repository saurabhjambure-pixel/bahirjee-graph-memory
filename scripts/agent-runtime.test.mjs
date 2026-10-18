/**
 * Agent runtime guards — the Phase 1 gate in the internal multi-agent plan §11.2.
 *
 * Phase 1's rule is that the agent layer is an OVERLAY on the existing stepped pipeline, not
 * a second orchestrator (§2.1, §14.7). So the most valuable assertions here are the ones that
 * prove the overlay has not started to diverge from the thing it overlays:
 *
 *   - every pipeline step has exactly one owning agent, and agents own contiguous ranges
 *   - agent-derived step order is IDENTICAL to `nextPipelineStep()` — the seam exists for
 *     fan-out later, and until then any difference is a bug, not a feature
 *   - contracts are well-formed and reference only known tools and artifact types
 *   - a checkpoint from another graph version is refused rather than silently resumed
 *   - every artifact an agent declares can actually be built, and stays a summary
 *
 * That last one exists because `recordArtifact()` sat written-but-never-called: six agents
 * declared nineteen artifact types and emitted none. A contract nothing checks is decoration.
 *
 * These run for real against the registry and builders — no source-grepping — because that is
 * what the checkpoint-replay work established as the standard after a suite of grep-only
 * assertions passed against code that could not run.
 *
 * Run: npm run test:agents
 */
import assert from 'node:assert/strict'
import fs, { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PIPELINE_STEPS, nextPipelineStep } from '../src/services/intelligenceService.js'
import {
  AGENTS, GRAPH_VERSION, agentForStep, agentIdForStep, getAgent,
  isAgentBoundary, isAgentEntry, listAgentIds, nextAgent, stepsForAgent, validateRegistry,
} from '../src/services/agents/registry.js'
import { isKnownArtifactType, isKnownTool } from '../src/services/agents/schemas.js'
import { resolveNext } from '../src/services/agents/orchestration/nextRunnableAgent.js'
import { buildGraphState, checkGraphCompatibility, CHECKPOINT_SOFT_LIMIT_BYTES } from '../src/services/agents/orchestration/checkpointStore.js'
import { buildArtifactsFor, agentIdsWithBuilders } from '../src/services/agents/orchestration/artifactBuilders.js'
import { TOOL_BY_ROUTE, enforceableTools, guardPostJson, resolveToolEnforcement, toolForUrl } from '../src/services/agents/orchestration/toolGuard.js'
import { describeGraph, graphProgress } from '../src/services/agents/orchestration/graphView.js'

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

console.log('\nagent runtime')

// ── 1. contracts ─────────────────────────────────────────────────────────────

await check('the registry is structurally consistent with the live pipeline', () => {
  const { ok, errors } = validateRegistry()
  assert.ok(ok, `registry self-check failed:\n    ${errors.join('\n    ')}`)
})

await check('every agent declares a complete contract', () => {
  for (const a of AGENTS) {
    for (const field of ['id', 'version', 'purpose', 'success_criteria', 'retry_policy', 'escalation_policy']) {
      assert.ok(a[field], `${a.id || '(unnamed)'} is missing "${field}"`)
    }
    assert.ok(Array.isArray(a.steps) && a.steps.length > 0, `${a.id} owns no steps`)
    assert.ok(Array.isArray(a.allowed_tools) && a.allowed_tools.length > 0, `${a.id} has no tool grant`)
    for (const t of a.allowed_tools) assert.ok(isKnownTool(t), `${a.id}: unknown tool "${t}"`)
    for (const t of a.artifact_types_emitted || []) {
      assert.ok(isKnownArtifactType(t), `${a.id}: unknown artifact type "${t}"`)
    }
  }
})

await check('every pipeline step has exactly one owning agent', () => {
  const owners = PIPELINE_STEPS.map(s => ({ step: s.name, agent: agentIdForStep(s.name) }))
  const orphans = owners.filter(o => !o.agent).map(o => o.step)
  assert.deepEqual(orphans, [], `steps with no owning agent: ${orphans.join(', ')}`)

  const claimed = AGENTS.flatMap(a => a.steps)
  const dupes = claimed.filter((s, i) => claimed.indexOf(s) !== i)
  assert.deepEqual([...new Set(dupes)], [], 'a step is claimed by more than one agent')
  assert.equal(claimed.length, PIPELINE_STEPS.length, 'agents claim a different number of steps than the pipeline has')
})

await check('agents own contiguous step ranges in pipeline order', () => {
  const names = PIPELINE_STEPS.map(s => s.name)
  for (const a of AGENTS) {
    const idx = a.steps.map(s => names.indexOf(s))
    assert.ok(idx.every(i => i >= 0), `${a.id} references a step not in the pipeline`)
    assert.ok(
      idx.every((v, i) => i === 0 || v === idx[i - 1] + 1),
      `${a.id} owns non-contiguous steps [${a.steps.join(', ')}] — an agent cannot be interleaved with another`
    )
  }
})

await check('entry and boundary detection agree with the declared step ranges', () => {
  for (const a of AGENTS) {
    const steps = stepsForAgent(a.id)
    assert.ok(isAgentEntry(steps[0]), `${a.id}: first step "${steps[0]}" is not reported as the entry`)
    assert.ok(isAgentBoundary(steps.at(-1)), `${a.id}: last step "${steps.at(-1)}" is not reported as the boundary`)
    for (const mid of steps.slice(1, -1)) {
      assert.ok(!isAgentEntry(mid), `${a.id}: middle step "${mid}" wrongly reported as an entry`)
      assert.ok(!isAgentBoundary(mid), `${a.id}: middle step "${mid}" wrongly reported as a boundary`)
    }
  }
})

// ── 2. selection: the overlay must not change execution order ────────────────

await check('agent-resolved step order is identical to the pipeline order', () => {
  // The seam exists for fan-out later. Until that lands, ANY divergence is a defect —
  // this is what makes turning AGENT_RUNTIME_MODE=resolve on a no-op rather than a gamble.
  for (const s of PIPELINE_STEPS) {
    assert.equal(
      resolveNext(s.name).step, nextPipelineStep(s.name),
      `resolveNext disagrees with nextPipelineStep after "${s.name}"`
    )
  }
})

await check('a deferred step keeps its own agent and emits no handoff', () => {
  for (const s of PIPELINE_STEPS.filter(x => x.cursored)) {
    const r = resolveNext(s.name, { deferred: true })
    assert.equal(r.step, s.name, `a deferred "${s.name}" must re-enter itself`)
    assert.equal(r.agent, agentIdForStep(s.name), `a deferred "${s.name}" changed owner`)
    assert.equal(r.handoff, null, `a deferred "${s.name}" emitted a handoff mid-agent`)
  }
})

await check('a handoff is emitted exactly at agent boundaries', () => {
  for (const s of PIPELINE_STEPS) {
    const r = resolveNext(s.name)
    const crosses = r.step && agentIdForStep(s.name) !== agentIdForStep(r.step)
    assert.equal(
      Boolean(r.handoff), Boolean(crosses),
      `handoff presence is wrong after "${s.name}" (crosses agents: ${crosses})`
    )
    if (r.handoff) {
      assert.equal(r.handoff.from_agent, agentIdForStep(s.name))
      assert.equal(r.handoff.to_agent, agentIdForStep(r.step))
    }
  }
})

await check('nextAgent walks the graph once and terminates', () => {
  const ids = listAgentIds()
  const seen = []
  let cur = ids[0]
  for (let i = 0; cur && i <= ids.length; i++) { seen.push(cur); cur = nextAgent(cur) }
  assert.equal(cur, null, 'the agent chain did not terminate')
  assert.deepEqual(seen, ids, 'nextAgent order diverges from the registry order')
  assert.equal(nextAgent(ids.at(-1)), null, 'the last agent must have no successor')
  assert.equal(getAgent('nope_agent'), null, 'unknown agent ids must resolve to null')
})

// ── 3. graph state and in-flight version compatibility ───────────────────────

await check('buildGraphState partitions agents around the current one', () => {
  const ids = listAgentIds()
  for (const s of PIPELINE_STEPS) {
    const g = buildGraphState(s.name)
    const cur = agentIdForStep(s.name)
    assert.equal(g.current_agent, cur, `wrong current_agent at "${s.name}"`)
    assert.equal(g.graph_version, GRAPH_VERSION)
    const partition = [...g.completed_agents, cur, ...g.pending_agents]
    assert.deepEqual(partition, ids, `completed+current+pending is not the full graph at "${s.name}"`)
  }
  const done = buildGraphState(null)
  assert.equal(done.current_agent, null, 'end of pipeline must have no current agent')
  assert.deepEqual(done.completed_agents, ids, 'end of pipeline must mark every agent complete')
})

await check('a checkpoint from the current graph resumes', () => {
  const r = checkGraphCompatibility({ graph_version: GRAPH_VERSION })
  assert.ok(r.ok && r.reason === null, 'a matching graph version must resume silently')
})

await check('a checkpoint with no graph version resumes (pre-agent or first step)', () => {
  assert.ok(checkGraphCompatibility(null).ok, 'a missing __graph must not block a fresh job')
  assert.ok(checkGraphCompatibility({}).ok, 'an empty __graph must not block a fresh job')
})

await check('a checkpoint from another graph version is REFUSED, with an actionable reason', () => {
  // The failure this prevents is silent: under a reordered step list every name still
  // resolves, so the job resumes happily and skips or repeats work with no error.
  const r = checkGraphCompatibility({ graph_version: 'v0-old' })
  assert.equal(r.ok, false, 'a mismatched graph version must not resume')
  assert.match(r.reason, /v0-old/, 'the reason must name the version found')
  assert.match(r.reason, new RegExp(GRAPH_VERSION), 'the reason must name the version expected')
  assert.match(r.reason, /re-run|ALLOW_GRAPH_VERSION_MISMATCH/, 'the reason must say what to do about it')
})

await check('the mismatch override is opt-in and reports that it was used', () => {
  const r = checkGraphCompatibility({ graph_version: 'v0-old' }, { allowMismatch: true })
  assert.ok(r.ok, 'the override must permit a resume')
  assert.ok(r.reason && /ALLOW_GRAPH_VERSION_MISMATCH/.test(r.reason), 'an overridden resume must still be reported')
})

// ── 4. artifacts: declared must equal buildable ──────────────────────────────

const stateFixture = {
  runId: 'run-fixture',
  context: {
    company_name: 'Acme Health', industry: 'Healthtech', operating_geography: 'India',
    key_competitors: [{ name: 'Rival A', domain: 'rival-a.com' }, { name: 'Rival B' }],
    customer_segments: ['hospitals'], strategic_anchors: { moat: 'distribution' },
    overall_confidence: 'medium',
  },
  memory: { lookbackMonths: 12, currentCards: [{}, {}] },
  queries: { buckets: { competitor_intel: ['q1', 'q2'], funding_intel: ['q3'] }, selected: ['q1', 'q2', 'q3'] },
  search: { cursor: 3, total: 3, phase: 'done', candidates: [{ url: 'https://a.test/x' }, { url: 'https://b.test/y' }] },
  v6: { patterns: [{}, {}], shifts: [], blindSpots: [{}], opportunities: [] },
  analyze: {
    batches: [['a'], ['b']],
    signals: [
      { signal_headline: 'A thing happened', source_url: 'https://a.test/x' },
      { signal_headline: 'Another thing', source_url: 'https://b.test/y' },
    ],
  },
  degradations: [{ step: 'Source watch', reason: 'x', impact: 'y' }],
  report: { id: 'rep-1', signals: [{}, {}], brief: 'text', card_summary: [{}] },
}

await check('every declared artifact type is actually produced by a builder', () => {
  assert.deepEqual(
    agentIdsWithBuilders().sort(), listAgentIds().sort(),
    'an agent has no artifact builder — it would declare outputs and emit none'
  )
  for (const a of AGENTS) {
    const built = new Set(buildArtifactsFor(a.id, stateFixture).map(x => x.artifactType))
    const declared = a.artifact_types_emitted || []
    const missing = declared.filter(t => !built.has(t))
    assert.deepEqual(missing, [], `${a.id} declares but never emits: ${missing.join(', ')}`)
    for (const t of built) {
      assert.ok(declared.includes(t), `${a.id} emits "${t}" without declaring it in its contract`)
    }
  }
})

await check('artifact payloads stay summaries, not evidence dumps', () => {
  // The whole point of artifacts living beside `observations` rather than containing them.
  for (const a of AGENTS) {
    for (const art of buildArtifactsFor(a.id, stateFixture)) {
      const size = JSON.stringify(art.payload).length
      assert.ok(
        size < 8 * 1024,
        `${a.id}/${art.artifactType} payload is ${size} bytes — artifacts carry references and rollups, not content`
      )
      assert.ok(size * 20 < CHECKPOINT_SOFT_LIMIT_BYTES * 4, `${a.id}/${art.artifactType} is disproportionate`)
    }
  }
})

await check('artifact builders are total — empty and partial state produce no throw', () => {
  for (const a of AGENTS) {
    assert.doesNotThrow(() => buildArtifactsFor(a.id, {}), `${a.id} threw on empty state`)
    assert.doesNotThrow(() => buildArtifactsFor(a.id, null), `${a.id} threw on null state`)
    assert.doesNotThrow(() => buildArtifactsFor(a.id, { context: null, analyze: null }), `${a.id} threw on partial state`)
  }
  assert.deepEqual(buildArtifactsFor('not_an_agent', stateFixture), [], 'an unknown agent must yield no artifacts')
})

// ── 4b. the graph view must not fork the progress calculation ────────────────

await check('graphProgress agrees with the checkpointed graph state', () => {
  // These were two separate implementations of "which agents are done" — one in the dead
  // runGraph.js, one in checkpointStore. Duplicated state maths does not stay in agreement;
  // it just stops being compared. graphProgress now delegates, and this pins that.
  for (const s of [...PIPELINE_STEPS.map(x => x.name), null]) {
    const view = graphProgress(s)
    const checkpoint = buildGraphState(s)
    assert.equal(view.current_agent, checkpoint.current_agent, `current_agent disagrees at "${s}"`)
    assert.deepEqual(view.completed_agents, checkpoint.completed_agents, `completed_agents disagrees at "${s}"`)
    assert.deepEqual(view.pending_agents, checkpoint.pending_agents, `pending_agents disagrees at "${s}"`)
    assert.equal(view.graph_version, checkpoint.graph_version)
  }
  assert.equal(graphProgress(null).percent, 100, 'a finished run must read as 100%')
  assert.equal(graphProgress(PIPELINE_STEPS[0].name).percent, 0, 'a run at the first step must read as 0%')
})

await check('describeGraph exposes every agent contract', () => {
  const d = describeGraph()
  assert.equal(d.graph_version, GRAPH_VERSION)
  assert.deepEqual(d.agents.map(a => a.id), listAgentIds(), 'describeGraph must cover every agent, in order')
  for (const a of d.agents) {
    assert.ok(a.purpose && a.success_criteria, `${a.id} is described without purpose or success criteria`)
    assert.ok(Array.isArray(a.allowed_tools) && a.allowed_tools.length, `${a.id} described with no tool grant`)
  }
})

// ── 4c. the upsert conflict target must exist in the schema ──────────────────

await check('beginAgentRun\'s ON CONFLICT matches a plain-column unique index', () => {
  // The first live replay found `beginAgentRun` failing on EVERY call with "there is no
  // unique or exclusion constraint matching the ON CONFLICT specification". v16 created the
  // identity index as an EXPRESSION index — `(job_id, agent_id, attempt, coalesce(shard_key,
  // ''))` — and Postgres cannot infer an expression index from a column list. Because
  // agentRunStore treats telemetry writes as non-blocking, and recordArtifact() needs an
  // agent_run_id, the whole telemetry layer was inert with no error surfaced.
  //
  // Twenty-eight assertions missed it because none of them touch Postgres. This one closes
  // that gap the same way observation-source-types.test.mjs does: compare the code's claim
  // against the migration that has to satisfy it.
  const store = fs.readFileSync(
    new URL('../src/services/agents/orchestration/agentRunStore.js', import.meta.url), 'utf8')

  const m = /onConflict:\s*'([^']+)'/.exec(store)
  assert.ok(m, 'beginAgentRun no longer declares an onConflict target')
  const declared = m[1].split(',').map(s => s.trim())

  // Latest migration that defines the identity index wins.
  const dir = fileURLToPath(new URL('../scripts/migrations', import.meta.url))
  const files = readdirSync(dir).filter(f => f.endsWith('.sql'))
    .map(f => ({ f, v: Number(/^v(\d+)/.exec(f)?.[1] ?? -1) }))
    .sort((a, b) => a.v - b.v)

  let index = null
  for (const { f } of files) {
    const sql = readFileSync(join(dir, f), 'utf8').split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    const created = /create\s+unique\s+index[^;]*uq_agent_runs_identity[^;]*?\(([^;]*?)\)\s*;/is.exec(sql)
    if (created) index = { file: f, cols: created[1] }
  }
  assert.ok(index, 'no migration creates uq_agent_runs_identity')

  assert.ok(
    !/coalesce/i.test(index.cols),
    `${index.file} defines uq_agent_runs_identity as an EXPRESSION index (${index.cols.trim()}). `
    + 'Postgres cannot infer that from an ON CONFLICT column list, so every upsert fails at runtime.'
  )

  const actual = index.cols.split(',').map(s => s.trim()).filter(Boolean)
  assert.deepEqual(
    actual, declared,
    `${index.file} indexes [${actual.join(', ')}] but beginAgentRun conflicts on [${declared.join(', ')}]`
  )
})

// ── 5. tool grants are enforced, not merely declared ─────────────────────────

await check('every provider route maps to exactly one tool', () => {
  for (const [route, tool] of Object.entries(TOOL_BY_ROUTE)) {
    assert.ok(isKnownTool(tool), `route "${route}" maps to unknown tool "${tool}"`)
    assert.equal(toolForUrl(`/api/${route}`), tool, `bare path for "${route}" did not resolve`)
    assert.equal(toolForUrl(`https://x.test/api/${route}`), tool, `absolute url for "${route}" did not resolve`)
    assert.equal(toolForUrl(`/api/${route}?x=1`), tool, `query string defeated the mapping for "${route}"`)
  }
  assert.equal(toolForUrl('/api/upload'), null, 'a non-provider route must not imply a tool')
  assert.equal(toolForUrl(null), null, 'a missing url must not imply a tool')
})

await check('a granted tool is never rejected by the guard', async () => {
  for (const step of PIPELINE_STEPS) {
    const agent = agentForStep(step.name)
    const granted = new Set(agent.allowed_tools || [])
    for (const [route, tool] of Object.entries(TOOL_BY_ROUTE)) {
      if (!granted.has(tool)) continue
      const guarded = guardPostJson(async () => ({ ok: true }), { stepName: step.name, mode: 'strict' })
      await assert.doesNotReject(
        () => guarded(`/api/${route}`, {}),
        `"${agent.id}" grants "${tool}" but the guard rejected /api/${route}`
      )
    }
  }
})

/**
 * Tools each step actually reaches, read off the call graph in intelligenceService.js.
 *
 * This is a REVIEWED CLAIM, not a derivation — it is what makes an *under*-grant catchable.
 * The check above cannot find one: it iterates the granted tools, so a grant that is missing
 * entirely is simply never tested. Both real contract errors were of exactly that shape.
 *
 * Drift in the other direction — this table going stale — is caught at runtime instead: with
 * AGENT_TOOL_ENFORCEMENT=strict an undeclared call fails the step loudly. So the table is the
 * pre-deploy guard and strict mode is the backstop; neither alone is sufficient.
 *
 * Only enforceable (postJson-routed) tools belong here. supabase:* does not flow through the
 * transport, so listing it would imply a coverage this cannot provide.
 */
const STEP_TOOL_REACH = {
  context: ['scrape', 'tavily', 'llm'],   // buildInitialContext → fetchLinkedInContext → Tavily
  memory: [],
  express: ['tavily', 'exa', 'llm'],
  discover_competitors: ['exa', 'tavily', 'llm'],
  validate_exa: ['exa'],
  generate_queries: ['llm'],
  search: ['tavily', 'exa', 'scrape', 'jev'],  // scoreDeepReadCandidates, per wave
  watch: ['scrape', 'jev'],               // stepWatch → watchSources + judgePageChanges (JEV_WATCH)
  // stepCollect reaches /api/connectors only, which is NOT provider-bound — it is absent
  // from TOOL_BY_ROUTE, so the guard cannot classify it and strict mode lets it through.
  // Listing a tool here would imply an enforcement this cannot provide (see the header).
  collect: ['connectors'],       // stepCollect → callConnector → /api/connectors
  v6_pipeline: ['jev'],                   // scoreStructuralFindings (JEV_SYNTHESIS)
  triage: ['jev'],                        // stepTriage → materiality per pre-cap observation
  analyze: ['llm'],
  // Coverage scoring itself is pure, but the gap-fill pass re-runs searchQuery (Tavily,
  // with the Exa fallback) and re-analyzes what it finds.
  verify: ['tavily', 'exa', 'llm'],
  summary: ['llm'],
  // Deliberately empty. `attest` is a pure policy pass over the brief `summary` just
  // wrote — no LLM, no network, no database. A verifier that can itself hallucinate is
  // worse than none, so if this list ever gains an entry, the gate has stopped being
  // deterministic and the reason needs to be a very good one.
  attest: [],
  // Jev's advisory read lives in its own step precisely so `attest` above can stay empty.
  review: ['jev'],
  interpret: ['llm'],
  // No LLM call since the 3-line news generation was deleted; Jev re-ranks (JEV_NEWS).
  news: ['jev'],
  persist: [],
}

await check('every tool a step actually reaches is granted to its owning agent', () => {
  assert.deepEqual(
    Object.keys(STEP_TOOL_REACH).sort(), PIPELINE_STEPS.map(s => s.name).sort(),
    'STEP_TOOL_REACH is out of sync with the pipeline — a new step needs its tool reach reviewed'
  )
  for (const [stepName, reach] of Object.entries(STEP_TOOL_REACH)) {
    const agent = agentForStep(stepName)
    const granted = new Set(agent.allowed_tools || [])
    const missing = reach.filter(t => !granted.has(t))
    assert.deepEqual(
      missing, [],
      `step "${stepName}" reaches [${missing.join(', ')}] but its agent "${agent.id}" does not grant it — `
      + 'under strict enforcement this step would fail at runtime'
    )
  }
})

await check('an ungranted provider call is refused in strict mode', async () => {
  // research_planner_agent is LLM-only, so a scrape from it is a contract breach.
  const guarded = guardPostJson(async () => ({ ok: true }), { stepName: 'generate_queries', mode: 'strict' })
  await assert.doesNotReject(() => guarded('/api/gemini', {}), 'the planner must keep its LLM grant')
  await assert.rejects(
    () => guarded('/api/scrape', { url: 'https://x.test' }),
    /does not grant it/,
    'an ungranted tool must be refused, or the grant is decoration'
  )
})

await check('warn mode reports the breach and still lets the call through', async () => {
  const seen = []
  const guarded = guardPostJson(async () => ({ ok: 'passed-through' }), {
    stepName: 'generate_queries', mode: 'warn', onViolation: v => seen.push(v),
  })
  const out = await guarded('/api/scrape', {})
  assert.deepEqual(out, { ok: 'passed-through' }, 'warn mode must not block the call')
  assert.equal(seen.length, 1, 'warn mode must report the violation')
  assert.equal(seen[0].tool, 'scrape')
  assert.equal(seen[0].agentId, 'research_planner_agent')
})

await check('off mode returns the transport untouched', () => {
  const raw = async () => ({})
  assert.equal(guardPostJson(raw, { stepName: 'generate_queries', mode: 'off' }), raw)
})

await check('enforcement coverage is declared honestly', () => {
  // supabase:read/write do NOT flow through postJson, so they cannot be enforced here.
  // Pinning the gap stops it being mistaken for coverage later.
  const enforceable = new Set(enforceableTools())
  assert.ok(enforceable.has('llm') && enforceable.has('tavily') && enforceable.has('scrape') && enforceable.has('exa'))
  assert.ok(!enforceable.has('supabase:read'), 'supabase reads do not pass through postJson — do not claim to enforce them')
  assert.ok(!enforceable.has('supabase:write'), 'supabase writes do not pass through postJson — do not claim to enforce them')
})

await check('mode resolution defaults to strict and rejects nonsense', () => {
  assert.equal(resolveToolEnforcement(undefined), 'strict')
  assert.equal(resolveToolEnforcement('banana'), 'strict', 'an unrecognised mode must fail closed')
  assert.equal(resolveToolEnforcement('warn'), 'warn')
  assert.equal(resolveToolEnforcement('OFF'), 'off')
})

await check('the signal artifact carries evidence references, not signal bodies', () => {
  const arts = buildArtifactsFor('signal_analyst_agent', stateFixture)
  const set = arts.find(x => x.artifactType === 'signal_set')
  assert.ok(set, 'signal_analyst_agent must emit a signal_set')
  assert.equal(set.payload.count, 2)
  assert.equal(set.payload.distinct_source_hosts, 2, 'host rollup is wrong')
  assert.deepEqual(set.evidenceRefs, ['https://a.test/x', 'https://b.test/y'], 'evidence refs must be the source urls')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
