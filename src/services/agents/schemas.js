/**
 * Shared schemas for the agent runtime.
 *
 * Defined once, on purpose. Schema drift between an agent's declared contract and what it
 * actually emits is the fastest way an agent system rots, so every spec references these
 * descriptors rather than restating field lists inline.
 *
 * Deliberately dependency-free — a validation library is not worth a runtime dependency
 * for shape checks this simple, and this module is imported by both the browser bundle and
 * the worker.
 */

/** Every artifact type an agent may emit. Specs may only declare types from this list. */
export const ARTIFACT_TYPES = Object.freeze({
    CONTEXT_SNAPSHOT: 'context_snapshot',
    CONTEXT_CONFIDENCE_REPORT: 'context_confidence_report',
    CONTEXT_GAPS: 'context_gaps',
    COMPETITOR_CANDIDATES: 'competitor_candidates',
    COMPETITOR_VALIDATION_REPORT: 'competitor_validation_report',
    RETRIEVAL_PLAN: 'retrieval_plan',
    QUERY_WAVE_PLAN: 'query_wave_plan',
    BUDGET_PLAN: 'budget_plan',
    EVIDENCE_LEDGER: 'evidence_ledger',
    RETRIEVAL_METRICS: 'retrieval_metrics',
    OBSERVATION_REFS: 'observation_refs',
    EXPRESS_QUERY_PLAN: 'express_query_plan',
    EXPRESS_SIGNAL_SET: 'express_signal_set',
    SIGNAL_SET: 'signal_set',
    PATTERN_SET: 'pattern_set',
    SHIFT_SET: 'shift_set',
    BLIND_SPOT_SET: 'blind_spot_set',
    OPPORTUNITY_SET: 'opportunity_set',
    VERIFICATION_REPORT: 'verification_report',
    REPORT_PAYLOAD: 'report_payload',
    MEMORY_UPDATE: 'memory_update',
});

const ARTIFACT_TYPE_VALUES = new Set(Object.values(ARTIFACT_TYPES));
export const isKnownArtifactType = (t) => ARTIFACT_TYPE_VALUES.has(t);

/** Tools an agent may be granted. An agent must not call anything outside its grant. */
export const TOOLS = Object.freeze({
    SCRAPE: 'scrape',
    TAVILY: 'tavily',
    EXA: 'exa',
    LLM: 'llm',
    SUPABASE_READ: 'supabase:read',
    SUPABASE_WRITE: 'supabase:write',
    PATTERN_ENGINE: 'engine:pattern',
    SHIFT_ENGINE: 'engine:shift',
    BLIND_SPOT_ENGINE: 'engine:blindspot',
    OPPORTUNITY_ENGINE: 'engine:opportunity',
    QUERY_GENERATOR: 'engine:querygen',
    // Structured-source APIs (tenders, filings, social) behind /api/connectors. Distinct
    // from TAVILY/EXA: those are search, these are direct data-source calls with their own
    // credentials and geo routing.
    CONNECTORS: 'connectors',
    // Typed decisions (scores, yes/no) behind /api/jev. Distinct from LLM: it generates no
    // text, and a step granted it can rank or flag evidence but never write prose.
    JEV: 'jev',
    VERIFIER: 'policy:verifier',
});

const TOOL_VALUES = new Set(Object.values(TOOLS));
export const isKnownTool = (t) => TOOL_VALUES.has(t);

/**
 * Minimal shape descriptor. `{ field: { type, required } }` where type is a typeof string,
 * 'array', or 'any'. Enough to catch drift; not a substitute for real tests.
 */
export function validateShape(value, schema, path = '') {
    const errors = [];
    if (value == null) {
        if (Object.values(schema).some(f => f.required)) {
            errors.push(`${path || '(root)'} is null but has required fields`);
        }
        return { ok: errors.length === 0, errors };
    }

    for (const [field, rule] of Object.entries(schema)) {
        const v = value[field];
        const here = path ? `${path}.${field}` : field;

        if (v === undefined || v === null) {
            if (rule.required) errors.push(`${here} is required but missing`);
            continue;
        }
        if (rule.type === 'any') continue;
        if (rule.type === 'array') {
            if (!Array.isArray(v)) errors.push(`${here} should be an array, got ${typeof v}`);
            continue;
        }
        if (Array.isArray(v) && rule.type === 'object') continue; // arrays are objects
        if (typeof v !== rule.type) errors.push(`${here} should be ${rule.type}, got ${typeof v}`);
    }
    return { ok: errors.length === 0, errors };
}

// ─── state-slice schemas ──────────────────────────────────────────────────
// These describe the slices of the pipeline `state` object each agent reads and writes.
// They document the real contract between steps, which until now was implicit.

export const SCHEMAS = Object.freeze({
    context_in: { runId: { type: 'string', required: true } },
    context_out: { context: { type: 'object', required: true } },

    // Express runs on the confirmed context alone and emits an early signal set. Its
    // output is optional by contract: a failed express must never fail the run.
    express_in: { context: { type: 'object', required: true } },
    express_out: { express: { type: 'object', required: false } },

    competitor_in: { context: { type: 'object', required: true } },
    competitor_out: { context: { type: 'object', required: true } },

    planner_in: { context: { type: 'object', required: true } },
    planner_out: { queries: { type: 'object', required: true } },

    retrieval_in: { queries: { type: 'object', required: true } },
    retrieval_out: { search: { type: 'object', required: true } },

    analyst_in: { search: { type: 'object', required: true } },
    analyst_out: { analyze: { type: 'object', required: true }, v6: { type: 'object', required: true } },

    // The verifier reads the analyzed signal set and returns a verdict; it writes no report.
    verifier_in: { analyze: { type: 'object', required: true } },
    verifier_out: { verify: { type: 'object', required: true } },

    // Synthesis may only run on a set the verifier has already cleared.
    synthesis_in: { analyze: { type: 'object', required: true }, verify: { type: 'object', required: true } },
    synthesis_out: { report: { type: 'object', required: false } },
});
