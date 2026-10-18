import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Turns verified findings into the founder-facing report, and persists it.
 *
 * Owns `summary`, `attest`, `interpret`, `news` and `persist`. Every one of those reads
 * `state.analyze.signals` — which `verifier_agent` has already gated — so the brief and the
 * published signal list describe the same evidence.
 *
 * ── Why this agent owns `attest`, despite judging its own output ─────────────
 *
 * `attest` checks the brief `summary` just wrote, and sits between `summary` and
 * `interpret`. Agents must own CONTIGUOUS step ranges, so any other owner would split this
 * agent in two; `verifier_agent` cannot take it either, because `summary` sits between
 * `verify` and `attest`.
 *
 * What preserves the judge/publisher separation in substance is that the attestation logic
 * is a deterministic policy in `policies/briefPolicy.js` — no LLM, no network, alongside
 * `verifierPolicy.js` — so this agent cannot talk itself into a pass. It also does not gate
 * publication: a failed attestation is disclosed as a degradation, never a refusal to
 * publish. The hard fail-closed guarantee still belongs to `verify`, whose verdict
 * `persist` requires and which `attest` deliberately never writes to.
 *
 * ── Why this is separate from the verifier (§5.6) ────────────────────────────
 *
 * This agent holds the only report and memory writes in the pipeline. Splitting it from the
 * judge means a defect in the verifier cannot publish, and a defect here cannot lower the
 * bar it was published against. `persist` reads the verdict from `state.verify.verdict` and
 * throws if it is missing: failing closed, because publishing without a verdict ships exactly
 * the unsupported claims the gate exists to remove, with nothing recording that it was
 * skipped.
 *
 * There is deliberately no branch that proceeds against a blocking verdict. An override is a
 * human action recorded in `agent_handoffs` with an actor id, not an agent decision.
 */
export const synthesisAgent = {
    id: 'synthesis_agent',
    version: 'v1',
    purpose: 'Assemble the founder-facing report from verified findings and persist it.',

    // `review` is Jev's advisory read of the brief. It sits here for the reason `attest` does
    // (agents own contiguous ranges) and, like attest, can never block or rewrite: it only
    // records hits and, in `on`, discloses them.
    steps: ['summary', 'attest', 'review', 'interpret', 'news', 'persist'],

    allowed_tools: [TOOLS.LLM, TOOLS.SUPABASE_READ, TOOLS.SUPABASE_WRITE, TOOLS.JEV],

    input_schema: SCHEMAS.synthesis_in,
    output_schema: SCHEMAS.synthesis_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.REPORT_PAYLOAD,
        ARTIFACT_TYPES.MEMORY_UPDATE,
    ],

    success_criteria: 'The published report contains only findings the verifier cleared, and carries its verdict.',

    retry_policy: 'standard',

    // This agent writes the report row. Report persistence is idempotent on run_id (v18), so
    // a replay updates rather than duplicates — but a failure mid-synthesis is still worth a
    // human look rather than a blind retry.
    escalation_policy: 'quarantine_output',

    handoff_targets: [],
};
