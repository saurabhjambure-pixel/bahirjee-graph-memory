#!/usr/bin/env node

/**
 * Replay an intelligence job from its checkpoint.
 *
 * SECURITY: this is a local admin CLI, never an HTTP handler. It reads the service-role
 * key from the environment and bypasses RLS entirely. Do not import it from a route, and
 * do not add an HTTP wrapper around it — the whole point is that it stays off the network
 * surface.
 *
 * Usage (--env-file is required; the script reads credentials from the environment):
 *   node --env-file=.env scripts/replay-job.js <jobId>                        # inspect (default, no side effects)
 *   node --env-file=.env scripts/replay-job.js <jobId> --verify               # checkpoint integrity check
 *   node --env-file=.env scripts/replay-job.js <jobId> --execute --step NAME  # actually re-run one step
 *
 * Execute-mode flags:
 *   --same-run-id     reuse the original run_id instead of a fresh one (will write
 *                     observations into the original run — off by default)
 *   --allow-persist   permit replaying the `persist` step, which saves a NEW report row
 *
 * Inspect and verify make no provider calls and write nothing. Execute issues real
 * provider calls (real money) and real database writes.
 */

import { createClient } from '@supabase/supabase-js';

import { internalPostJson } from '../api/_internalRouteClient.js';
import {
    PIPELINE_STEPS,
    PipelineTimer,
    addRunWallClock,
    configureIntelligenceRuntime,
    createPipelineState,
    getCircuitState,
    getPipelineStep,
    getRunProvenance,
    getRunSpend,
    nextPipelineStep,
    runPipelineStep,
    setCircuitState,
    setRunProvenance,
    setRunSpend,
} from '../src/services/intelligenceService.js';
import { currentVersions } from '../src/services/pipelineVersions.js';
import { agentIdForStep } from '../src/services/agents/registry.js';

// ─── args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

// Flags that consume the following token as their value; everything else positional.
const VALUED = new Set(['--step']);
const values = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) { values[a.slice(2)] = argv[++i]; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
}
const value = (name) => values[name] ?? null;

const jobId = positional[0];
const MODE = flag('execute') ? 'execute' : flag('verify') ? 'verify' : 'inspect';

if (!jobId) {
    console.error('Usage: node --env-file=.env scripts/replay-job.js <jobId> [--verify | --execute --step NAME]');
    process.exit(1);
}

// ─── supabase (service role) ──────────────────────────────────────────────

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
    console.error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

// ─── diffing ──────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object';

/** Collect differing paths between two JSON-ish values. Arrays compare by index. */
function diff(a, b, path = '', out = []) {
    if (a === b) return out;

    if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            out.push({ path: path || '(root)', from: preview(a), to: preview(b) });
        }
        return out;
    }

    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        diff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    return out;
}

function preview(v) {
    if (v === undefined) return '(absent)';
    const s = JSON.stringify(v);
    if (s == null) return String(v);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

const count = (v) => (Array.isArray(v) ? v.length : v == null ? 0 : 1);

// ─── load ─────────────────────────────────────────────────────────────────

const { data: job, error } = await supabase
    .from('intelligence_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

if (error || !job) {
    console.error(`Could not load job ${jobId}: ${error?.message || 'not found'}`);
    process.exit(1);
}

const stepOutputs = job.step_outputs || {};
const control = stepOutputs.__control || {};
const storedState = stepOutputs.state || null;

// ─── inspect ──────────────────────────────────────────────────────────────

console.log(`\nJob ${job.id}`);
console.log(`  status          ${job.status}`);
console.log(`  current_step    ${job.current_step || '(none)'}`);
console.log(`  attempts        ${job.attempt_count}`);
console.log(`  created         ${job.created_at}`);
console.log(`  report_id       ${job.report_id || '(none)'}`);
if (job.error_message) console.log(`  error           ${job.error_message}`);

console.log(`\nCheckpoint (__control)`);
console.log(`  next step       ${control.step ?? '(none — job finished or never started)'}`);
console.log(`  run_id          ${control.run_id || '(none)'}`);
console.log(`  retriggers      ${control.retrigger_count ?? 0}`);
console.log(`  cursor          ${control.cursor_fingerprint ?? '(none)'}`);
console.log(`  circuit         ${JSON.stringify(control.circuit || {})}`);

console.log(`\nBudget (__control.budget)`);
if (control.budget) {
    const b = control.budget;
    console.log(`  tokens          ${b.tokens?.total ?? 0} ${JSON.stringify(b.tokens?.byProvider || {})}`);
    console.log(`  calls           ${b.calls?.total ?? 0} ${JSON.stringify(b.calls?.byTool || {})}`);
    console.log(`  est. cost USD   ${b.cost_usd?.total ?? 0}`);
    console.log(`  wall clock      ${((b.wall_clock_ms ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  failed calls    ${b.failures ?? 0}`);
} else {
    console.log('  (none — job predates budget recording)');
}

console.log(`\nVersions (__control.versions)`);
console.log(`  recorded        ${JSON.stringify(control.versions || '(none — job predates version pinning)')}`);
console.log(`  current code    ${JSON.stringify(currentVersions())}`);
if (control.versions) {
    const drift = diff(control.versions, currentVersions());
    if (drift.length) {
        console.log(`  ⚠ drift since this run:`);
        for (const d of drift) console.log(`      ${d.path}: ${d.from} → ${d.to}`);
    } else {
        console.log(`  ✓ no drift`);
    }
}

console.log(`\nAgent graph (__graph)`);
if (stepOutputs.__graph) {
    const g = stepOutputs.__graph;
    console.log(`  graph_version   ${g.graph_version}`);
    console.log(`  current agent   ${g.current_agent || '(none — graph complete)'}`);
    console.log(`  completed       ${g.completed_agents?.length ? g.completed_agents.join(', ') : '(none)'}`);
    console.log(`  pending         ${g.pending_agents?.length ? g.pending_agents.join(', ') : '(none)'}`);
    console.log(`  run_mode        ${g.run_mode || '(unset)'}`);
    if (g.failed_agents?.length) console.log(`  failed          ${g.failed_agents.join(', ')}`);
} else {
    console.log(`  (none — job predates the agent runtime, or AGENT_RUNTIME_MODE=off)`);
    if (control.step) console.log(`  owner of next step "${control.step}": ${agentIdForStep(control.step) || '(unmapped)'}`);
}

const provenance = stepOutputs.__provenance || [];
console.log(`\nProvenance   ${provenance.length} LLM call(s)`);
if (provenance.length) {
    const byAction = {};
    for (const p of provenance) {
        const k = `${p.action}/${p.provider}`;
        byAction[k] = byAction[k] || { calls: 0, ok: 0, tokens: 0 };
        byAction[k].calls++;
        if (p.ok) byAction[k].ok++;
        byAction[k].tokens += Number(p.tokens) || 0;
    }
    for (const [k, v] of Object.entries(byAction)) {
        console.log(`  ${k.padEnd(34)} ${v.ok}/${v.calls} ok, ${v.tokens} tok`);
    }
}

console.log(`\nState`);
if (!storedState) {
    console.log('  (no persisted state — job never checkpointed)');
} else {
    console.log(`  runId           ${storedState.runId}`);
    for (const key of ['context', 'memory', 'queries', 'search', 'analyze', 'summary', 'interpret', 'news']) {
        console.log(`  ${key.padEnd(15)} ${storedState[key] == null ? '(null)' : `present (${count(storedState[key])} item(s) / object)`}`);
    }
    const v6 = storedState.v6 || {};
    console.log(`  v6              patterns=${count(v6.patterns)} shifts=${count(v6.shifts)} blindSpots=${count(v6.blindSpots)} opportunities=${count(v6.opportunities)}`);
}

if (MODE === 'inspect') {
    console.log(`\nRun with --verify to check checkpoint integrity, or --execute --step <name> to replay a step.\n`);
    process.exit(0);
}

// ─── verify ───────────────────────────────────────────────────────────────

if (MODE === 'verify') {
    console.log(`\n─── checkpoint integrity ───`);
    let failures = 0;
    const check = (ok, label, detail = '') => {
        console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
        if (!ok) failures++;
    };

    if (!storedState) {
        check(false, 'state present', 'nothing to replay from');
    } else {
        // The checkpoint survives a serverless boundary only as JSON. Anything that does
        // not round-trip (undefined, Date, Map, circular) is silent corruption on resume.
        let roundTripped = null;
        try {
            roundTripped = JSON.parse(JSON.stringify(storedState));
            check(true, 'state is JSON-serializable');
        } catch (e) {
            check(false, 'state is JSON-serializable', e.message);
        }

        if (roundTripped) {
            const drift = diff(storedState, roundTripped);
            check(drift.length === 0, 'state round-trips losslessly',
                drift.length ? `${drift.length} field(s) changed` : '');
            for (const d of drift.slice(0, 10)) console.log(`      ${d.path}: ${d.from} → ${d.to}`);
        }

        check(Boolean(storedState.runId), 'state carries a runId');

        // A fresh state must have every key the stored one does, or resume reads undefined.
        const shape = createPipelineState({}, storedState.runId);
        const missing = Object.keys(shape).filter(k => !(k in storedState));
        check(missing.length === 0, 'state has all expected keys',
            missing.length ? `missing: ${missing.join(', ')}` : '');
    }

    check(control.run_id === (storedState?.runId ?? control.run_id),
        'control.run_id matches state.runId',
        `${control.run_id} vs ${storedState?.runId}`);

    if (control.step) {
        check(Boolean(getPipelineStep(control.step)), `next step "${control.step}" exists in the registry`);
    }

    // Observations live outside the checkpoint on purpose. If the run is past `search`,
    // they must still be reachable or a resumed analyze step would silently see nothing.
    if (control.run_id) {
        const { count: obsCount, error: obsErr } = await supabase
            .from('observations')
            .select('id', { count: 'exact', head: true })
            .eq('run_id', control.run_id);
        if (obsErr) {
            check(false, 'observations reachable', obsErr.message);
        } else {
            const pastSearch = storedState?.search != null;
            check(!pastSearch || obsCount > 0, 'observations reachable for run_id',
                `${obsCount ?? 0} row(s)${pastSearch ? '' : ' (run has not reached search yet)'}`);
        }
    }

    console.log(failures === 0
        ? `\n✓ checkpoint is intact — safe to replay\n`
        : `\n✗ ${failures} check(s) failed\n`);
    process.exit(failures === 0 ? 0 : 1);
}

// ─── execute ──────────────────────────────────────────────────────────────

const stepName = value('step') || control.step;
if (!stepName) {
    console.error('\n--execute needs --step <name> (no next step recorded on this job).');
    process.exit(1);
}

const stepDef = getPipelineStep(stepName);
if (!stepDef) {
    console.error(`\nUnknown step "${stepName}". Known: ${PIPELINE_STEPS.map(s => s.name).join(', ')}`);
    process.exit(1);
}

if (stepName === 'persist' && !flag('allow-persist')) {
    console.error('\nRefusing to replay `persist` — it writes a NEW report row. Pass --allow-persist if that is what you want.');
    process.exit(1);
}

if (!storedState) {
    console.error('\nNo persisted state to replay from.');
    process.exit(1);
}

console.log(`\n─── executing "${stepName}" ───`);
console.log('  ⚠ this makes REAL provider calls (real cost) and REAL database writes.');

// Replay into a fresh run_id by default so a re-run cannot pollute the original run's
// observations. The unique index is (run_id, source_url, source_type), so reusing the
// original id would silently merge replayed rows into the real run.
const replayState = JSON.parse(JSON.stringify(storedState));
if (!flag('same-run-id')) {
    replayState.runId = crypto.randomUUID();
    console.log(`  replay run_id   ${replayState.runId} (original ${storedState.runId})`);
} else {
    console.log(`  replay run_id   ${replayState.runId} (REUSING original — writes merge into the real run)`);
}

const before = JSON.parse(JSON.stringify(replayState));

setRunProvenance(stepOutputs.__provenance || []);
setCircuitState(control.circuit);
setRunSpend(control.budget);
const spendBefore = getRunSpend();

configureIntelligenceRuntime({ postJson: internalPostJson });

const timer = new PipelineTimer(Number(process.env.STEP_MAX_MS || 45000));
const ctx = {
    job: {
        websiteUrl: job.website_url,
        linkedinUrl: job.linkedin_url,
        uploadedDocText: job.uploaded_doc_text || null,
        userId: job.created_by,
        clientId: job.client_id,
        requestedByRole: job.requested_by_role || 'client_user',
    },
    onProgress: (m) => console.log(`    · ${m}`),
    timer,
    stepped: true,
};

const t0 = Date.now();
let outcome;
try {
    outcome = await runPipelineStep(stepName, replayState, ctx);
} catch (e) {
    console.error(`\n✗ step threw: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
}
addRunWallClock(timer.elapsed());

console.log(`\n  completed in    ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  defer           ${outcome.defer}`);
console.log(`  pause           ${outcome.pause || '(none)'}`);
console.log(`  next step       ${outcome.defer ? stepName : (nextPipelineStep(stepName) || '(end of pipeline)')}`);

const spendAfter = getRunSpend();
console.log(`\n  spend this step`);
console.log(`    tokens        +${(spendAfter.tokens?.total ?? 0) - (spendBefore.tokens?.total ?? 0)}`);
console.log(`    calls         +${(spendAfter.calls?.total ?? 0) - (spendBefore.calls?.total ?? 0)}`);
console.log(`    est. cost USD +${((spendAfter.cost_usd?.total ?? 0) - (spendBefore.cost_usd?.total ?? 0)).toFixed(6)}`);

const changes = diff(before, replayState);
console.log(`\n─── state diff (${changes.length} field(s) changed) ───`);
if (changes.length === 0) {
    console.log('  (no change — the step was a no-op on this state)');
} else {
    for (const c of changes.slice(0, 40)) {
        console.log(`  ${c.path}`);
        console.log(`     from ${c.from}`);
        console.log(`     to   ${c.to}`);
    }
    if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
}

console.log('\nNothing was written back to intelligence_jobs — this replay did not advance the real job.\n');
