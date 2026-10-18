/**
 * Version pins for the intelligence pipeline.
 *
 * Every run records these into `intelligence_jobs.step_outputs.__control.versions` so a
 * quality regression can be attributed to the thing that changed. Bump the relevant
 * constant in the same commit that changes the underlying behaviour — a version that
 * silently lags its subject is worse than no version at all.
 *
 * Deliberately dependency-free: this module is imported by both the browser bundle and
 * the serverless worker, so it must not pull in prompt bodies or anything using
 * `process.env` at module scope.
 */

/**
 * Prompt templates in `promptUtils.js`. Bump on any wording/schema change to a prompt.
 *
 * v2 (2026-08-16): buildSummary and generateDecisionBrief gained the brief.v2 judgment
 * fields (why_it_matters, what_could_change_our_view, what_to_consider) and the
 * `VOICE: JUDGMENT, NOT INSTRUCTION` block, which relaxes the previous blanket ban on
 * saying what the evidence favours. interpretShifts is deliberately unchanged — it is a
 * lens over deterministic detections, and the layer where invented advice would be least
 * detectable. A v1 brief has no confidence or falsifier fields at all.
 */
export const PROMPT_VERSION = 'v2';

/**
 * Shape of the pipeline graph itself (step list and their order in `PIPELINE_STEPS`).
 * Bump when steps are added, removed, or reordered.
 *
 * v2 (2026-08-16): `attest` inserted immediately after `summary`. checkGraphCompatibility
 * refuses to resume a checkpoint written under a different graph, which is correct — a v1
 * checkpoint has no attest output and its step indices no longer line up. In-flight jobs
 * fail across this deploy by design; ship it in a quiet window rather than setting
 * ALLOW_GRAPH_VERSION_MISMATCH=1.
 *
 * ⚠️  This constant is for ATTRIBUTION only. The version `checkGraphCompatibility` actually
 *     enforces is the identically-named export in `agents/registry.js`. Bump both when a
 *     step is added; bumping only this one changes nothing about checkpoint safety.
 */
// v4: `express` (added under registry v4 without a bump here) and `triage`, between
//     v6_pipeline and analyze.
// v5: `review`, between attest and interpret.
export const GRAPH_VERSION = 'v5';

/**
 * Agent contract specs. 'v0' means the pre-agent stepped pipeline — there are no agent
 * specs yet. Becomes 'v1' when the agent registry lands.
 */
export const AGENT_SPEC_VERSION = 'v0';

/**
 * Verifier gate thresholds. Bump on any threshold change in
 * `agents/policies/verifierPolicy.js` — a verdict is only comparable across runs that
 * scored it with the same rules.
 *
 * v2 (2026-08-16): the gate SET changed, not a threshold. `insight_grounding` was removed —
 * it read a brief that does not exist at `verify` time, so it reported `pass` on every run
 * without checking anything — and `competitor_validation` started receiving the tracked
 * entities it had always been starved of. A v1 verdict therefore lists a gate a v2 verdict
 * does not, and carries a `competitor_validation: pass` that was never earned.
 */
export const VERIFIER_POLICY_VERSION = 'v2';

/**
 * Brief attestation gates in `agents/policies/briefPolicy.js`. Separate from the verifier
 * version because the two score different objects at different points in the run and are
 * not comparable — the verifier judges signals before the brief exists, this judges the
 * brief afterwards.
 *
 * Bump on any threshold change, including the confidence ceiling in
 * `briefSchema.calibrateConfidence`.
 *
 * v2 — the confidence ceiling now gates on source-class diversity (>=2 Medium, >=3 High)
 * and is capped by the verifier's own warnings (one warn caps at Medium, two at Low).
 * Both were previously measured and ignored: classes were empty on every run because
 * getObservationsForRun never selected the column, and gate warnings reached the report
 * but not the level. Adds gate B6, narrative_complete. Levels are NOT comparable across
 * this boundary — a v1 'High' and a v2 'High' were computed from different inputs.
 */
export const BRIEF_POLICY_VERSION = 'v2';

/** Run-level version pin recorded once per job in the checkpoint envelope. */
export function currentVersions() {
    return {
        prompt_version: PROMPT_VERSION,
        graph_version: GRAPH_VERSION,
        agent_spec_version: AGENT_SPEC_VERSION,
        verifier_policy_version: VERIFIER_POLICY_VERSION,
        brief_policy_version: BRIEF_POLICY_VERSION,
    };
}
