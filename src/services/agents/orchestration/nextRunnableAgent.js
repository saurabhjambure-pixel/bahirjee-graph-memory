/**
 * Next-step / next-agent selection.
 *
 * In Phase 1 this deliberately delegates to the existing linear pipeline order. It exists
 * as a seam: when retrieval fan-out arrives, sharding branches here rather than inside the
 * worker. Keeping it provably identical to `nextPipelineStep` today is the point — the
 * runtime should change nothing until the thing that needs it lands.
 */

import { nextPipelineStep } from '../../intelligenceService.js';
import { agentIdForStep, isAgentBoundary, nextAgent } from '../registry.js';

/**
 * Resolve the step to run after `stepName`.
 *
 * @param {string} stepName   step that just completed
 * @param {boolean} deferred  true when the step ran out of invocation budget mid-cursor
 * @returns {{ step: string|null, agent: string|null, handoff: object|null }}
 */
export function resolveNext(stepName, { deferred = false } = {}) {
    // A deferred cursored step keeps ownership: same step, same agent, no handoff.
    if (deferred) {
        return { step: stepName, agent: agentIdForStep(stepName), handoff: null };
    }

    const step = nextPipelineStep(stepName);
    const fromAgent = agentIdForStep(stepName);
    const toAgent = step ? agentIdForStep(step) : null;

    const handoff = isAgentBoundary(stepName) && fromAgent && toAgent && fromAgent !== toAgent
        ? { from_agent: fromAgent, to_agent: toAgent, reason: 'completed_all_owned_steps', at: new Date().toISOString() }
        : null;

    return { step, agent: toAgent, handoff };
}

/** Agent that should run once `agentId` finishes. Null at end of graph. */
export const resolveNextAgent = (agentId) => nextAgent(agentId);
