/**
 * Agent registry — the contract layer over the existing stepped pipeline.
 *
 * This is an OVERLAY, not a replacement. The worker still executes exactly one pipeline
 * step per serverless invocation, because that is what the 60s invocation ceiling allows.
 * An agent here is a named, contracted *group of contiguous steps* — it says who owns the
 * step currently running, what that owner is allowed to touch, and what it promises to
 * emit. Execution granularity is unchanged, which is what makes adopting this safe.
 *
 * The grouping is verified against the live PIPELINE_STEPS at import time by
 * `validateRegistry()`, so a step added to the pipeline without an owning agent is a loud
 * failure rather than a silent gap.
 */

import { PIPELINE_STEPS } from '../intelligenceService.js';
import { isKnownArtifactType, isKnownTool } from './schemas.js';

import { competitorScoutAgent } from './specs/competitorScoutAgent.js';
import { contextAgent } from './specs/contextAgent.js';
import { evidenceRetrievalAgent } from './specs/evidenceRetrievalAgent.js';
import { expressAgent } from './specs/expressAgent.js';
import { researchPlannerAgent } from './specs/researchPlannerAgent.js';
import { signalAnalystAgent } from './specs/signalAnalystAgent.js';
import { synthesisAgent } from './specs/synthesisAgent.js';
import { verifierAgent } from './specs/verifierAgent.js';

/** Execution order. Mirrors the pipeline order and is asserted against it below. */
export const AGENTS = Object.freeze([
    contextAgent,
    expressAgent,
    competitorScoutAgent,
    researchPlannerAgent,
    evidenceRetrievalAgent,
    signalAnalystAgent,
    verifierAgent,
    synthesisAgent,
]);

// The AGENT graph version — this is the one `checkGraphCompatibility` compares a
// checkpoint against, so bumping it makes in-flight jobs re-queue from step zero.
//
// ⚠️  Not the same constant as `pipelineVersions.GRAPH_VERSION`, which shares the name but
//     records the STEP list for run attribution and gates nothing. Both must move when a
//     step is added; only this one has teeth.
//
// v2: `watch`, `collect` and `verify` joined the pipeline in the main merge.
// v3: `attest` joined, owned by synthesis_agent — a checkpoint written under v2 has no
//     attestation and would publish a brief that was never checked against its evidence.
// v4: `express` joined between context and competitor_scout. A v3 checkpoint has no
//     express stage; re-queuing is correct rather than merely safe.
// v5: `triage` joined between v6_pipeline and analyze (Jev materiality scores for the
//     observation cap). A v4 checkpoint would resume past it — harmless, since an unscored
//     run is exactly the pre-triage behaviour — but the rule is one bump per step change.
// v6: `review` joined between attest and interpret (Jev's advisory read of the brief).
export const GRAPH_VERSION = 'v6';

const BY_ID = new Map(AGENTS.map(a => [a.id, a]));
const BY_STEP = new Map();
for (const agent of AGENTS) {
    for (const step of agent.steps) BY_STEP.set(step, agent.id);
}

export const getAgent = (id) => BY_ID.get(id) || null;
export const agentIdForStep = (stepName) => BY_STEP.get(stepName) || null;
export const agentForStep = (stepName) => getAgent(agentIdForStep(stepName));
export const listAgentIds = () => AGENTS.map(a => a.id);

/** Steps owned by an agent, in pipeline order. */
export const stepsForAgent = (id) => (getAgent(id)?.steps ?? []).slice();

/** True when `stepName` is the last step its agent owns — i.e. the handoff point. */
export function isAgentBoundary(stepName) {
    const agent = agentForStep(stepName);
    if (!agent) return false;
    return agent.steps[agent.steps.length - 1] === stepName;
}

/** True when `stepName` is the first step its agent owns — where an agent run opens. */
export function isAgentEntry(stepName) {
    const agent = agentForStep(stepName);
    if (!agent) return false;
    return agent.steps[0] === stepName;
}

/**
 * The agent that should run after `agentId` completes. Returns null at the end of the
 * graph. Handoff targets are declared per-spec; this asserts they agree with the order.
 */
export function nextAgent(agentId) {
    const idx = AGENTS.findIndex(a => a.id === agentId);
    if (idx < 0 || idx === AGENTS.length - 1) return null;
    return AGENTS[idx + 1].id;
}

/**
 * Structural self-check. Cheap enough to run at import: a registry that has drifted from
 * the pipeline is a bug that should surface immediately, not on a production run.
 */
export function validateRegistry(steps = PIPELINE_STEPS) {
    const errors = [];
    const pipelineNames = steps.map(s => s.name);

    const owned = [];
    for (const agent of AGENTS) {
        for (const field of ['id', 'version', 'purpose', 'success_criteria', 'retry_policy', 'escalation_policy']) {
            if (!agent[field]) errors.push(`${agent.id || '(unnamed)'}: missing "${field}"`);
        }
        if (!Array.isArray(agent.steps) || agent.steps.length === 0) {
            errors.push(`${agent.id}: declares no steps`);
            continue;
        }
        for (const t of agent.allowed_tools || []) {
            if (!isKnownTool(t)) errors.push(`${agent.id}: unknown tool "${t}"`);
        }
        for (const a of agent.artifact_types_emitted || []) {
            if (!isKnownArtifactType(a)) errors.push(`${agent.id}: unknown artifact type "${a}"`);
        }
        for (const target of agent.handoff_targets || []) {
            if (!BY_ID.has(target)) errors.push(`${agent.id}: handoff target "${target}" is not a registered agent`);
        }

        const idx = agent.steps.map(s => pipelineNames.indexOf(s));
        if (idx.some(i => i < 0)) {
            errors.push(`${agent.id}: references step(s) not in the pipeline: `
                + agent.steps.filter(s => !pipelineNames.includes(s)).join(', '));
        } else if (!idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)) {
            errors.push(`${agent.id}: owns non-contiguous steps [${agent.steps.join(', ')}]`);
        }
        owned.push(...agent.steps);
    }

    const unowned = pipelineNames.filter(n => !owned.includes(n));
    if (unowned.length) errors.push(`pipeline steps with no owning agent: ${unowned.join(', ')}`);

    const dupes = owned.filter((s, i) => owned.indexOf(s) !== i);
    if (dupes.length) errors.push(`steps claimed by more than one agent: ${[...new Set(dupes)].join(', ')}`);

    // Agent order must match the order their steps appear in the pipeline.
    const firstIdx = AGENTS.map(a => pipelineNames.indexOf(a.steps[0]));
    if (!firstIdx.every((v, i) => i === 0 || v > firstIdx[i - 1])) {
        errors.push('AGENTS order does not match pipeline step order');
    }

    // Declared handoffs must agree with execution order, or the graph lies about itself.
    for (let i = 0; i < AGENTS.length - 1; i++) {
        const declared = AGENTS[i].handoff_targets || [];
        if (declared.length && !declared.includes(AGENTS[i + 1].id)) {
            errors.push(`${AGENTS[i].id}: handoff_targets ${JSON.stringify(declared)} does not include the next agent "${AGENTS[i + 1].id}"`);
        }
    }

    return { ok: errors.length === 0, errors };
}

const selfCheck = validateRegistry();
if (!selfCheck.ok) {
    console.error('[agents] registry is inconsistent with the pipeline:\n  ' + selfCheck.errors.join('\n  '));
}
