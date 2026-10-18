import { ARTIFACT_TYPES, SCHEMAS, TOOLS } from '../schemas.js';

/**
 * Runs one fast, deterministic pass over the context the founder just confirmed, so the
 * report has grounded signals in it within about a minute instead of two and a half.
 *
 * Its own agent rather than a member of context_agent or competitor_scout_agent, for two
 * concrete reasons. Joining context_agent would push the context artifacts (snapshot,
 * confidence, gaps) a minute later and inherit `pause_for_human_review`, which is the
 * opposite of what a speculative accelerator wants. Joining competitor_scout_agent would
 * make express the agent ENTRY, so a deferring express would reopen the scout's run on
 * every invocation and reset its spend baseline.
 *
 * Single-step, so it opens and closes inside one invocation on the happy path.
 */
export const expressAgent = {
    id: 'express_agent',
    version: 'v1',
    purpose: 'Produce a first grounded signal set from the confirmed context, fast.',

    steps: ['express'],

    // EXA is not optional despite express only "searching". searchQuery falls back to Exa
    // whenever Tavily errors, and under strict tool enforcement an ungranted /api/exa call
    // throws ToolPermissionError out of guardedPostJson and fails the WHOLE run — a
    // failure that only reproduces when Tavily is down, so it would ship green.
    allowed_tools: [TOOLS.TAVILY, TOOLS.EXA, TOOLS.LLM, TOOLS.SUPABASE_READ, TOOLS.SUPABASE_WRITE],

    input_schema: SCHEMAS.express_in,
    output_schema: SCHEMAS.express_out,

    artifact_types_emitted: [
        ARTIFACT_TYPES.EXPRESS_QUERY_PLAN,
        ARTIFACT_TYPES.EXPRESS_SIGNAL_SET,
    ],

    success_criteria:
        'A small set of grounded signals exists early, or the run continues unharmed '
        + 'with the shortfall disclosed.',

    retry_policy: 'none',

    // The whole point is that it is optional. Express is an accelerator, never a
    // dependency: a failure costs the founder some waiting, never the report.
    escalation_policy: 'degrade_and_continue',

    handoff_targets: ['competitor_scout_agent'],
};
