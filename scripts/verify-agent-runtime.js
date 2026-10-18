#!/usr/bin/env node

/**
 * Verify the v15 + v16 migrations end to end.
 *
 * Checks that the columns and tables exist, that a real write/read round-trip works, that
 * the idempotency key actually upserts rather than duplicating, and — most importantly —
 * that RLS blocks an unauthenticated reader from seeing agent telemetry.
 *
 * SECURITY: local admin CLI, never an HTTP handler. Reads the service-role key from the
 * environment.
 *
 * Probe rows are written against a real job (the FK requires one), tagged with a reserved
 * agent_id, and deleted in a finally block so a failure mid-run still cleans up.
 *
 * Usage:
 *   node --env-file=.env scripts/verify-agent-runtime.js
 */

import { createClient } from '@supabase/supabase-js';

const PROBE_AGENT_ID = '__verify_probe__';

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !serviceKey) {
    console.error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

const db = createClient(url, serviceKey);
const anon = anonKey ? createClient(url, anonKey) : null;

let failures = 0;
const check = (ok, label, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

let probeRunId = null;
let jobId = null;

try {
    // ─── schema presence ───
    console.log('\n─── schema ───');

    const { error: verErr } = await db.from('reports').select('verification').limit(1);
    check(!verErr, 'reports.verification exists (v15)', verErr?.message || '');

    for (const t of ['agent_runs', 'agent_artifacts', 'agent_handoffs', 'agent_evaluations']) {
        const { error } = await db.from(t).select('id').limit(1);
        check(!error, `${t} exists (v16)`, error?.message || '');
    }

    if (failures > 0) {
        console.log('\nSchema is incomplete — apply the migrations before re-running.\n');
        process.exit(1);
    }

    // ─── round-trip ───
    console.log('\n─── write / read round-trip ───');

    const { data: job } = await db
        .from('intelligence_jobs')
        .select('id, client_id')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (!job) {
        console.log('  ! no intelligence_jobs row to attach a probe to — skipping round-trip');
    } else {
        jobId = job.id;

        const { data: run, error: runErr } = await db
            .from('agent_runs')
            .upsert({
                job_id: jobId, agent_id: PROBE_AGENT_ID, agent_version: 'v1',
                attempt: 1, shard_key: null, status: 'running',
            }, { onConflict: 'job_id,agent_id,attempt,shard_key' })
            .select('id')
            .single();
        check(!runErr && run?.id, 'agent_runs insert', runErr?.message || `id=${run?.id}`);
        probeRunId = run?.id;

        // The whole point of coalesce(shard_key,'') in the unique index: a repeat of the
        // same identity must update, not insert a second row.
        const { data: again, error: againErr } = await db
            .from('agent_runs')
            .upsert({
                job_id: jobId, agent_id: PROBE_AGENT_ID, agent_version: 'v1',
                attempt: 1, shard_key: null, status: 'completed',
            }, { onConflict: 'job_id,agent_id,attempt,shard_key' })
            .select('id')
            .single();
        check(!againErr && again?.id === probeRunId, 'idempotency key upserts (no duplicate row)',
            againErr?.message || `same id=${again?.id === probeRunId}`);

        const { count } = await db
            .from('agent_runs')
            .select('id', { count: 'exact', head: true })
            .eq('job_id', jobId)
            .eq('agent_id', PROBE_AGENT_ID);
        check(count === 1, 'exactly one probe run row exists', `count=${count}`);

        const { data: art, error: artErr } = await db
            .from('agent_artifacts')
            .insert({
                job_id: jobId, agent_run_id: probeRunId,
                artifact_type: 'context_snapshot', payload: { probe: true },
                source_count: 3, evidence_refs: [{ url: 'https://example.com' }],
            })
            .select('id')
            .single();
        check(!artErr && art?.id, 'agent_artifacts insert', artErr?.message || '');

        const { data: ho, error: hoErr } = await db
            .from('agent_handoffs')
            .insert({
                job_id: jobId, from_agent_run_id: probeRunId,
                to_agent_id: 'competitor_scout_agent', handoff_reason: 'probe',
            })
            .select('id')
            .single();
        check(!hoErr && ho?.id, 'agent_handoffs insert', hoErr?.message || '');

        const { data: ev, error: evErr } = await db
            .from('agent_evaluations')
            .insert({
                job_id: jobId, agent_run_id: probeRunId,
                policy_version: 'v1', scorecard: { probe: true }, passed: true,
            })
            .select('id')
            .single();
        check(!evErr && ev?.id, 'agent_evaluations insert', evErr?.message || '');

        // Cascade integrity: artifacts must be reachable from their run.
        const { data: joined } = await db
            .from('agent_artifacts')
            .select('id, artifact_type, agent_runs!inner(agent_id)')
            .eq('agent_run_id', probeRunId);
        check(joined?.length === 1 && joined[0].agent_runs.agent_id === PROBE_AGENT_ID,
            'artifact joins back to its run', `rows=${joined?.length}`);
    }

    // ─── RLS ───
    // The security property from the plan: agent telemetry must not be world-readable.
    console.log('\n─── RLS ───');
    if (!anon) {
        console.log('  ! no anon key in env — skipping (set VITE_SUPABASE_ANON_KEY to check)');
    } else {
        for (const t of ['agent_runs', 'agent_artifacts', 'agent_handoffs', 'agent_evaluations']) {
            const { data, error } = await anon.from(t).select('id').limit(5);
            // An unauthenticated caller must get either an explicit denial or zero rows —
            // never actual data.
            const blocked = Boolean(error) || (Array.isArray(data) && data.length === 0);
            check(blocked, `${t} is not readable anonymously`,
                error ? `denied (${error.code})` : `${data?.length ?? 0} rows returned`);
        }
    }
} finally {
    // ─── cleanup ───
    if (probeRunId) {
        console.log('\n─── cleanup ───');
        // agent_artifacts / agent_evaluations cascade from agent_runs; handoffs null out
        // their FK, so remove those explicitly.
        await db.from('agent_handoffs').delete().eq('from_agent_run_id', probeRunId);
        await db.from('agent_handoffs').delete().eq('job_id', jobId).eq('handoff_reason', 'probe');
        const { error } = await db.from('agent_runs').delete().eq('id', probeRunId);
        check(!error, 'probe rows removed', error?.message || '');

        const { count } = await db
            .from('agent_runs')
            .select('id', { count: 'exact', head: true })
            .eq('agent_id', PROBE_AGENT_ID);
        check(count === 0, 'no probe rows left behind', `remaining=${count}`);
    }
}

console.log(failures === 0
    ? '\n✓ agent runtime persistence verified end to end\n'
    : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
