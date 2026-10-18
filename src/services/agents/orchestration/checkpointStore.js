/**
 * Checkpoint envelope read/write.
 *
 * The envelope stored in `intelligence_jobs.step_outputs` is the only thing that survives
 * a serverless invocation boundary, so its shape is load-bearing. This module owns that
 * shape in one place instead of leaving it inline in the worker.
 *
 * Envelope:
 *   {
 *     state:         serializable pipeline state (NOT raw evidence — that lives in observations)
 *     __provenance:  per-LLM-call records
 *     __control:     { step, run_id, retrigger_count, cursor_fingerprint, circuit, budget, versions }
 *     __graph:       agent-level progress (added by the agent runtime; additive)
 *   }
 *
 * Hard rule: large payloads never enter this envelope. It is rewritten on every single
 * invocation, so anything bulky here multiplies row churn, polling latency and lock
 * contention. References and rollups only.
 */

import { GRAPH_VERSION, agentIdForStep, listAgentIds } from '../registry.js';

/** Rough guard against the envelope becoming a dumping ground. */
export const CHECKPOINT_SOFT_LIMIT_BYTES = 512 * 1024;

/**
 * Decide whether a checkpoint written by an earlier graph may be resumed.
 *
 * A deploy lands while jobs are mid-flight. Their checkpoints name a step and an owning
 * agent from the graph that was current when they were written, and resuming one under a
 * changed graph is silently wrong in ways the pipeline cannot detect for itself:
 *
 *   - a RENAMED step surfaces as "Unknown pipeline step" mid-run — loud, but only after the
 *     job has already burned its budget
 *   - a REORDERED step is worse: every name still resolves, so the job resumes happily and
 *     skips or repeats work with no error at all
 *
 * The second case is why "does the step still exist?" is not a sufficient test, and why
 * this refuses rather than tries to be clever. Per §4.1 of the multi-agent plan the choice
 * is (a) a retained compatibility path or (b) fail fast and re-queue from step zero. This
 * implements (b): losing a partial run costs one re-run, while a silently mis-sequenced run
 * costs a wrong report that nobody knows to distrust.
 *
 * Escape hatch: ALLOW_GRAPH_VERSION_MISMATCH=1 forces a resume. It exists for the operator
 * who knows a given bump was cosmetic; it is deliberately not the default.
 *
 * @param {object|null} previousGraph  `__graph` as read from the checkpoint
 * @param {object}      opts
 * @returns {{ ok: boolean, reason: string|null, previous: string|null, current: string }}
 */
export function checkGraphCompatibility(previousGraph, { allowMismatch = false } = {}) {
    const previous = previousGraph?.graph_version ?? null;

    // No prior version: either a fresh job, or one checkpointed before the agent runtime
    // existed. Both are safe — there is no agent-level state to misinterpret, and the step
    // name is still validated against PIPELINE_STEPS by the caller.
    if (!previous) return { ok: true, reason: null, previous: null, current: GRAPH_VERSION };

    if (previous === GRAPH_VERSION) {
        return { ok: true, reason: null, previous, current: GRAPH_VERSION };
    }

    if (allowMismatch) {
        return {
            ok: true,
            reason: `graph ${previous} → ${GRAPH_VERSION}: resumed anyway (ALLOW_GRAPH_VERSION_MISMATCH)`,
            previous,
            current: GRAPH_VERSION,
        };
    }

    return {
        ok: false,
        previous,
        current: GRAPH_VERSION,
        reason: `Checkpoint was written by graph ${previous}, but this deployment runs ${GRAPH_VERSION}. `
            + 'Resuming across a graph change can silently skip or repeat steps, so this job is failed '
            + 'rather than resumed — re-run it to start cleanly on the current graph. '
            + '(Set ALLOW_GRAPH_VERSION_MISMATCH=1 to override when the change is known to be compatible.)',
    };
}

export function readEnvelope(job) {
    const stepOutputs = job?.step_outputs || {};
    return {
        state: stepOutputs.state || null,
        provenance: stepOutputs.__provenance || [],
        control: stepOutputs.__control || {},
        graph: stepOutputs.__graph || null,
    };
}

/**
 * Build the `__graph` block for the step about to be checkpointed.
 *
 * `currentStep` is the step that will run NEXT (null at end of pipeline), matching the
 * meaning of `__control.step`. Completed agents are derived from position in the graph
 * rather than tracked incrementally, so this cannot drift out of sync with reality.
 */
export function buildGraphState(nextStepName, {
    runMode = 'founder', previous = null, currentAgentRunId = null, spendAtAgentStart = null,
} = {}) {
    const all = listAgentIds();
    const currentAgent = nextStepName ? agentIdForStep(nextStepName) : null;
    const idx = currentAgent ? all.indexOf(currentAgent) : all.length;

    return {
        graph_version: GRAPH_VERSION,
        current_agent: currentAgent,
        completed_agents: all.slice(0, Math.max(0, idx)),
        pending_agents: currentAgent ? all.slice(idx + 1) : [],
        failed_agents: previous?.failed_agents || [],
        run_mode: runMode,
        // Carried across invocations so a multi-step agent keeps one agent_runs row, and so
        // its cost can be derived as a delta against the run-level ledger.
        current_agent_run_id: currentAgentRunId,
        spend_at_agent_start: spendAtAgentStart,
    };
}

/** Assemble the full envelope to persist. Additive: unknown prior keys are preserved. */
export function buildEnvelope({ state, provenance, control, graph, previous = {} }) {
    return {
        ...previous,
        state,
        __provenance: provenance,
        __control: control,
        ...(graph ? { __graph: graph } : {}),
    };
}

/**
 * Size check for the assembled envelope. Returns bytes and whether it crossed the soft
 * limit — callers log rather than fail, since refusing to checkpoint would strand the job.
 */
export function measureEnvelope(envelope) {
    let bytes = 0;
    try {
        bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    } catch {
        return { bytes: -1, oversize: false, unserializable: true };
    }
    return { bytes, oversize: bytes > CHECKPOINT_SOFT_LIMIT_BYTES, unserializable: false };
}
