import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Executes the search waves, normalizes and dedupes what comes back, and persists
 * observations outside the job checkpoint.
 *
 * Wraps `search`, `watch` and `collect` — every step that puts evidence into
 * `observations`. All three are cursored: each processes a wave/source/connector per
 * invocation and defers, which is also the seam parallel retrieval fan-out will branch at.
 * `watch` reads tracked entities' own pages (the run's only first-party evidence) and
 * `collect` queries the structured connectors; both fail soft and neither may abort a run.
 */
export const evidenceRetrievalAgent = {
    id: 'evidence_retrieval_agent',
    version: 'v1',
    purpose: 'Execute search waves and persist deduped, provenance-linked evidence.',

    steps: ['search', 'watch', 'collect'],

    allowed_tools: [TOOLS.TAVILY, TOOLS.EXA, TOOLS.SCRAPE, TOOLS.SUPABASE_WRITE,
        // `collect` calls the structured-source APIs through /api/connectors.
        TOOLS.CONNECTORS,
        // `search` scores deep-read candidates and `watch` judges page changes through /api/jev.
        TOOLS.JEV,
    ],

    input_schema: SCHEMAS.retrieval_in,
    output_schema: SCHEMAS.retrieval_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.EVIDENCE_LEDGER,
        ARTIFACT_TYPES.RETRIEVAL_METRICS,
        ARTIFACT_TYPES.OBSERVATION_REFS,
    ],

    success_criteria: 'Evidence is persisted, source-normalized, deduped and provenance-linked.',

    retry_policy: 'network_tolerant',

    // Individual providers fail routinely; the run should proceed on whatever evidence was
    // gathered rather than abort the whole job over one dead source.
    escalation_policy: 'degrade_and_continue',

    handoff_targets: ['signal_analyst_agent'],

    // Observation writes are idempotent on (run_id, source_url, source_type), so replaying
    // this agent cannot double-count evidence.
    idempotency_key: 'run_id + source_url + source_type',
};
