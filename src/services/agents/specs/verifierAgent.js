import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Judges whether the assembled findings are fit to publish. Writes no report.
 *
 * Owns the `verify` step, which does two things in order:
 *   1. COVERAGE (reportVerifier.js) — which sections came back thin, and one bounded
 *      gap-fill round for the retryable ones.
 *   2. GROUNDING (agents/policies/verifierPolicy.js) — drop findings with no usable source,
 *      and collapse duplicates.
 *
 * Both run BEFORE `summary`/`interpret`/`news`. That ordering is the point: those steps read
 * `state.analyze.signals`, so gating afterwards would let the brief cite findings that never
 * appear in the published report. It did exactly that until 2026-08-13.
 *
 * ── Why this is separate from synthesis (§5.6) ───────────────────────────────
 *
 * The judge must not be the writer. This agent produces a verdict and nothing else;
 * `synthesis_agent` may only publish what the verdict cleared, and has no branch that
 * proceeds against a blocking one. An override is a human action recorded in
 * `agent_handoffs`, not something an agent can decide.
 *
 * ── On "read-only" ───────────────────────────────────────────────────────────
 *
 * This agent is NOT read-only, and a contract claiming otherwise would be wrong on contact
 * with the code: the coverage gap-fill re-runs retrieval and appends observations. What it
 * must never hold is REPORT or MEMORY persistence — those belong to synthesis. The grants
 * below are scoped to exactly that distinction.
 *
 * The stricter arrangement (§5.6 option 2) is to make gap-fill a handoff back to
 * `evidence_retrieval_agent` so this agent holds no write at all. That is a graph change
 * rather than a contract change and is deliberately left for when fan-out makes the loop-back
 * edge worth building.
 */
export const verifierAgent = {
    id: 'verifier_agent',
    version: 'v1',
    purpose: 'Judge coverage and grounding, and emit a verdict that gates publication.',

    steps: ['verify'],

    allowed_tools: [
        // Gap fill: re-search the thin sections and re-analyze what comes back.
        TOOLS.TAVILY,
        TOOLS.EXA,
        TOOLS.LLM,
        // Gap-fill evidence is written to `observations`; reading is needed to score it.
        TOOLS.SUPABASE_READ,
        TOOLS.SUPABASE_WRITE,
        TOOLS.VERIFIER,
        // Deliberately absent: no report or memory persistence. A bug here can fail the run
        // or thin it — it cannot publish.
    ],

    input_schema: SCHEMAS.verifier_in,
    output_schema: SCHEMAS.verifier_out,

    artifact_types_emitted: [ARTIFACT_TYPES.VERIFICATION_REPORT],

    success_criteria: 'Unsupported and duplicate findings are removed before synthesis, and a verdict is recorded.',

    retry_policy: 'standard',

    // A gap fill is bounded to one round on purpose. Iterating until the coverage check
    // passes would be a verifier talking itself into a pass; the honest alternative when a
    // gap survives is disclosure, never a relaxed bar (internal design log).
    escalation_policy: 'disclose_and_continue',

    handoff_targets: ['synthesis_agent'],
};
