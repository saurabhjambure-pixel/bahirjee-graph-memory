import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Converts context and the competitor set into a retrieval strategy: which themes are
 * worth searching, in what order, and against what budget.
 *
 * Wraps the existing `generate_queries` step, which is deterministic first and only falls
 * back to an LLM when template coverage is insufficient.
 */
export const researchPlannerAgent = {
    id: 'research_planner_agent',
    version: 'v1',
    purpose: 'Turn context and competitors into a budgeted retrieval plan.',

    steps: ['generate_queries'],

    allowed_tools: [TOOLS.QUERY_GENERATOR, TOOLS.LLM],

    input_schema: SCHEMAS.planner_in,
    output_schema: SCHEMAS.planner_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.RETRIEVAL_PLAN,
        ARTIFACT_TYPES.QUERY_WAVE_PLAN,
        ARTIFACT_TYPES.BUDGET_PLAN,
    ],

    success_criteria: 'Every planned query maps to an explicit theme, entity and retrieval objective.',

    retry_policy: 'standard',

    // The deterministic generator is the primary path; the LLM is already the fallback, so
    // a failure here means both failed and there is nothing left to degrade to.
    escalation_policy: 'fail_fast',

    handoff_targets: ['evidence_retrieval_agent'],
};
