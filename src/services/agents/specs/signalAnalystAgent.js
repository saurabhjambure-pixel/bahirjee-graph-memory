import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Extracts grounded signals from the evidence and runs the deterministic structural
 * engines over them.
 *
 * Wraps the `v6_pipeline`, `triage` and `analyze` steps. The structural engines stay
 * deterministic tools rather than becoming LLM judgement — that separation is the reason
 * pattern, shift, blind-spot and opportunity candidates are reproducible. Jev
 * (JEV_SYNTHESIS=on) may only drop a candidate from the report or lower its confidence; it
 * never creates one, and never touches the engines' stored rows.
 */
export const signalAnalystAgent = {
    id: 'signal_analyst_agent',
    version: 'v1',
    purpose: 'Extract grounded signals and derive structural findings from them.',

    // `verify` moved to verifier_agent (§5.6): the agent that judges the findings must not
    // also be the one that produced them, or a weak extraction can be waved through by the
    // same code that wrote it.
    // `triage` scores the rows the observation cap chooses among; it sits inside this agent
    // because its output only ever changes which evidence `analyze` receives.
    steps: ['v6_pipeline', 'triage', 'analyze'],

    allowed_tools: [
        TOOLS.LLM,
        TOOLS.SUPABASE_READ,
        TOOLS.SUPABASE_WRITE,
        TOOLS.PATTERN_ENGINE,
        TOOLS.SHIFT_ENGINE,
        TOOLS.BLIND_SPOT_ENGINE,
        TOOLS.OPPORTUNITY_ENGINE,
        // Typed confidence on candidate findings, and triage scores before analysis.
        TOOLS.JEV,
    ],

    input_schema: SCHEMAS.analyst_in,
    output_schema: SCHEMAS.analyst_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.SIGNAL_SET,
        ARTIFACT_TYPES.PATTERN_SET,
        ARTIFACT_TYPES.SHIFT_SET,
        ARTIFACT_TYPES.BLIND_SPOT_SET,
        ARTIFACT_TYPES.OPPORTUNITY_SET,
    ],

    success_criteria: 'Findings carry source links, dates and evidence counts.',

    retry_policy: 'standard',
    escalation_policy: 'degrade_and_continue',

    handoff_targets: ['verifier_agent'],
};
