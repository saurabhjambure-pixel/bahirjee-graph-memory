import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Discovers peer companies, validates weak candidates against live search, and ranks them
 * by relevance and evidence quality.
 *
 * Wraps the existing `discover_competitors` and `validate_exa` steps.
 */
export const competitorScoutAgent = {
    id: 'competitor_scout_agent',
    version: 'v1',
    purpose: 'Discover, validate and rank competitors with traceable evidence.',

    steps: ['discover_competitors', 'validate_exa'],

    // SUPABASE_WRITE because `validate_exa` pre-seeds funding observations through
    // appendObservations() — this agent writes evidence, not just competitor names. Also
    // missing until enforcement caught it.
    allowed_tools: [TOOLS.EXA, TOOLS.TAVILY, TOOLS.LLM, TOOLS.SUPABASE_READ, TOOLS.SUPABASE_WRITE],

    input_schema: SCHEMAS.competitor_in,
    output_schema: SCHEMAS.competitor_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.COMPETITOR_CANDIDATES,
        ARTIFACT_TYPES.COMPETITOR_VALIDATION_REPORT,
    ],

    success_criteria: 'Top competitors carry traceable evidence and a confidence score.',

    retry_policy: 'standard',

    // Competitor discovery is enrichment, not a gate — a run with a thin competitor set is
    // still a useful report, so degrade rather than stop.
    escalation_policy: 'degrade_and_continue',

    handoff_targets: ['research_planner_agent'],
};
