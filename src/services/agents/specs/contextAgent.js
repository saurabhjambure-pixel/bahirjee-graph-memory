import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Collects source material and fuses website, LinkedIn and uploaded-document context into
 * a structured company context, then loads prior-run memory for the same company.
 *
 * Wraps the existing `context` and `memory` pipeline steps — it does not reimplement them.
 */
export const contextAgent = {
    id: 'context_agent',
    version: 'v1',
    purpose: 'Build structured company context and load cross-run memory.',

    steps: ['context', 'memory'],

    // TAVILY is not optional here even though this agent never "searches" in the product
    // sense: buildInitialContext() → fetchLinkedInContext() falls back to a Tavily query to
    // find the company's LinkedIn page when the founder did not supply one. The grant was
    // missing until tool enforcement went in and immediately caught it — which is the whole
    // argument for enforcing declarations rather than trusting them.
    allowed_tools: [TOOLS.SCRAPE, TOOLS.TAVILY, TOOLS.LLM, TOOLS.SUPABASE_READ, TOOLS.SUPABASE_WRITE],

    input_schema: SCHEMAS.context_in,
    output_schema: SCHEMAS.context_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.CONTEXT_SNAPSHOT,
        ARTIFACT_TYPES.CONTEXT_CONFIDENCE_REPORT,
        ARTIFACT_TYPES.CONTEXT_GAPS,
    ],

    success_criteria:
        'Company name, geography, industry, strategic anchors and baseline competitors are '
        + 'present or explicitly marked unknown.',

    retry_policy: 'standard',

    // Context is the highest-leverage input in the run: everything downstream inherits it.
    // A weak read is worth a human glance rather than another silent model call.
    escalation_policy: 'pause_for_human_review',

    handoff_targets: ['express_agent'],
};
