/**
 * Persistence for the agent runtime tables (v16).
 *
 * Two rules govern everything here:
 *
 * 1. This is telemetry, not the product. A failure to record an agent run must never fail
 *    the intelligence run itself, so every call swallows its error and returns null. If
 *    the v16 migration has not been applied, the pipeline keeps working and simply records
 *    nothing.
 * 2. Writes are keyed for replay. Runs upsert on (job_id, agent_id, attempt, shard_key) so
 *    a re-triggered invocation updates its row instead of inserting a duplicate.
 *
 * Artifacts are append-only by design — never updated in place, because mutating a prior
 * artifact breaks replay determinism.
 *
 * The Supabase client is passed in rather than imported so the caller controls which
 * credentials are used (the worker holds the service role).
 */

const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST204']);

let warnedMissing = false;

/** Log once, quietly. A missing table is a deployment state, not a per-call emergency. */
function handle(error, op) {
    if (!error) return null;
    if (MISSING_TABLE_CODES.has(error.code)) {
        if (!warnedMissing) {
            warnedMissing = true;
            console.warn('[agents] agent runtime tables unavailable (v16 migration not applied) — '
                + 'skipping agent telemetry. The pipeline is unaffected.');
        }
        return null;
    }
    console.warn(`[agents] ${op} failed (non-blocking): ${error.message}`);
    return null;
}

/**
 * Open (or re-open) an agent run. Idempotent: replaying the same
 * job/agent/attempt/shard updates the existing row.
 *
 * @returns {Promise<string|null>} agent_run id, or null if telemetry is unavailable
 */
/**
 * Open (or re-open) an agent run.
 *
 * `shardKey` defaults to '' rather than null on purpose. The unique index this upsert
 * targets is `(job_id, agent_id, attempt, shard_key)`, and a NULL shard_key would compare
 * distinct from every other NULL — so a replayed unsharded run would insert a second row
 * instead of matching the first. v16 solved that with `coalesce(shard_key, '')` in the
 * index, but an expression index cannot be inferred from an ON CONFLICT column list, so
 * every call failed. v17 moves the coalesce into the column default; this keeps the caller
 * side consistent with it.
 */
export async function beginAgentRun(supabase, {
    jobId, agentId, agentVersion = 'v1', attempt = 1, shardKey = '', leaseExpiresAt = null,
}) {
    if (!supabase || !jobId || !agentId) return null;
    try {
        const { data, error } = await supabase
            .from('agent_runs')
            .upsert({
                job_id: jobId,
                agent_id: agentId,
                agent_version: agentVersion,
                attempt,
                shard_key: shardKey,
                status: 'running',
                lease_expires_at: leaseExpiresAt,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'job_id,agent_id,attempt,shard_key' })
            .select('id')
            .single();

        if (error) return handle(error, 'beginAgentRun');
        return data?.id ?? null;
    } catch (e) {
        return handle(e, 'beginAgentRun');
    }
}

/** Close an agent run with its terminal status and cost. */
export async function completeAgentRun(supabase, agentRunId, {
    status = 'completed', stepsCompleted = [], tokenUsage = null,
    providerCostUsd = null, confidence = null, failureReason = null,
} = {}) {
    if (!supabase || !agentRunId) return null;
    try {
        const { error } = await supabase
            .from('agent_runs')
            .update({
                status,
                steps_completed: stepsCompleted,
                token_usage: tokenUsage,
                provider_cost_usd: providerCostUsd,
                confidence,
                failure_reason: failureReason,
                completed_at: ['completed', 'failed', 'skipped', 'quarantined'].includes(status)
                    ? new Date().toISOString()
                    : null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', agentRunId);

        return error ? handle(error, 'completeAgentRun') : agentRunId;
    } catch (e) {
        return handle(e, 'completeAgentRun');
    }
}

/**
 * Append an artifact.
 *
 * `payload` must be a summary or a set of references — never bulk evidence. Raw scrape
 * content belongs in `observations`; copying it here would recreate the exact bloat the
 * split between checkpoint and history exists to avoid.
 */
export async function recordArtifact(supabase, {
    jobId, agentRunId, artifactType, artifactVersion = 'v1',
    payload = {}, sourceCount = 0, evidenceRefs = [],
}) {
    if (!supabase || !jobId || !agentRunId || !artifactType) return null;
    try {
        const { data, error } = await supabase
            .from('agent_artifacts')
            .insert({
                job_id: jobId,
                agent_run_id: agentRunId,
                artifact_type: artifactType,
                artifact_version: artifactVersion,
                payload,
                source_count: sourceCount,
                evidence_refs: evidenceRefs,
            })
            .select('id')
            .single();

        if (error) return handle(error, 'recordArtifact');
        return data?.id ?? null;
    } catch (e) {
        return handle(e, 'recordArtifact');
    }
}

/** Record an explicit agent-to-agent transition. */
export async function recordHandoff(supabase, {
    jobId, fromAgentRunId = null, toAgentId, handoffReason = null, decisionPayload = {},
}) {
    if (!supabase || !jobId || !toAgentId) return null;
    try {
        const { data, error } = await supabase
            .from('agent_handoffs')
            .insert({
                job_id: jobId,
                from_agent_run_id: fromAgentRunId,
                to_agent_id: toAgentId,
                handoff_reason: handoffReason,
                decision_payload: decisionPayload,
            })
            .select('id')
            .single();

        if (error) return handle(error, 'recordHandoff');
        return data?.id ?? null;
    } catch (e) {
        return handle(e, 'recordHandoff');
    }
}

/** Read back a job's agent history — used by the replay CLI and future dashboards. */
export async function getAgentHistory(supabase, jobId) {
    if (!supabase || !jobId) return { runs: [], artifacts: [], handoffs: [] };
    try {
        const [runs, artifacts, handoffs] = await Promise.all([
            supabase.from('agent_runs').select('*').eq('job_id', jobId).order('started_at'),
            supabase.from('agent_artifacts').select('*').eq('job_id', jobId).order('created_at'),
            supabase.from('agent_handoffs').select('*').eq('job_id', jobId).order('created_at'),
        ]);
        if (runs.error) { handle(runs.error, 'getAgentHistory'); return { runs: [], artifacts: [], handoffs: [], unavailable: true }; }
        return {
            runs: runs.data || [],
            artifacts: artifacts.data || [],
            handoffs: handoffs.data || [],
        };
    } catch (e) {
        handle(e, 'getAgentHistory');
        return { runs: [], artifacts: [], handoffs: [], unavailable: true };
    }
}
