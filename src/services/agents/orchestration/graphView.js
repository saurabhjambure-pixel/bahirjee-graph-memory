/**
 * Read-only views over the agent graph.
 *
 * Answers questions *about* a run at agent granularity — who owns the current step, how far
 * the graph has progressed, what each agent is contracted to do. It reads; it never drives.
 *
 * ── Why this is not called runGraph.js ───────────────────────────────────────
 *
 * It was. The name implied a second orchestrator sitting beside `runOneStep()`, which is the
 * specific failure §14.7 of the multi-agent plan warns about and which §12 calls out by
 * name: there is exactly one driver, and it lives in the worker. The module was also dead —
 * nothing imported it — while carrying its own copy of the completed/pending calculation and
 * its own `agentMayUse()`. Dead code that duplicates live logic does not stay correct; it
 * just stops being checked.
 *
 * So: renamed to say what it is, `graphProgress()` now delegates to the single
 * implementation in checkpointStore.js, and `agentMayUse()` is gone — tool grants are
 * enforced for real in toolGuard.js rather than described here.
 */

import { PIPELINE_STEPS } from '../../intelligenceService.js';
import { AGENTS, GRAPH_VERSION, agentForStep, stepsForAgent } from '../registry.js';
import { buildGraphState } from './checkpointStore.js';

/** Static description of the graph — for docs, dashboards and tests. */
export function describeGraph() {
    return {
        graph_version: GRAPH_VERSION,
        agents: AGENTS.map(a => ({
            id: a.id,
            version: a.version,
            purpose: a.purpose,
            steps: a.steps.slice(),
            allowed_tools: (a.allowed_tools || []).slice(),
            artifact_types_emitted: (a.artifact_types_emitted || []).slice(),
            success_criteria: a.success_criteria,
            retry_policy: a.retry_policy,
            escalation_policy: a.escalation_policy,
            handoff_targets: (a.handoff_targets || []).slice(),
        })),
    };
}

/**
 * Progress of a run, given the step that will execute next (`__control.step`).
 * A null `nextStepName` means the pipeline finished.
 *
 * The agent partition comes from `buildGraphState()` — the same function the worker
 * checkpoints with — so a dashboard and a checkpoint can never disagree about which agents
 * are done. Only the step-level percentage is added here.
 */
export function graphProgress(nextStepName) {
    const stepNames = PIPELINE_STEPS.map(s => s.name);
    const { graph_version, current_agent, completed_agents, pending_agents } = buildGraphState(nextStepName);

    const stepIdx = nextStepName ? stepNames.indexOf(nextStepName) : stepNames.length;
    const done = stepIdx >= 0 ? stepIdx : 0;

    return {
        graph_version,
        current_agent,
        completed_agents,
        pending_agents,
        steps_done: done,
        steps_total: stepNames.length,
        percent: Math.round((done / stepNames.length) * 100),
    };
}

/** Convenience: the agent that owns a step, as a full spec object. */
export const ownerOf = (stepName) => agentForStep(stepName);

export { stepsForAgent };
