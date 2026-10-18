/**
 * Tool-grant enforcement.
 *
 * Every agent spec declares `allowed_tools`. Until this module existed that declaration was
 * inert: `agentMayUse()` in runGraph.js said so in its own comment — "nothing enforces them
 * at call sites yet". A permission nothing checks is documentation, and documentation drifts.
 * It had: turning this on immediately caught `context_agent` reaching Tavily and
 * `competitor_scout_agent` writing observations, neither of which was declared.
 *
 * ── Where enforcement actually happens ───────────────────────────────────────
 *
 * The pipeline reaches every *network* provider through one function:
 * `intelligenceRuntime.postJson(url, body)`, injected by the worker. That single chokepoint
 * is what makes this cheap — the guard wraps it per step with the owning agent's grant, and
 * no step needs to know it is being policed.
 *
 * ── What this deliberately does NOT cover ────────────────────────────────────
 *
 * `supabase:read` / `supabase:write` do NOT pass through postJson — services import the
 * Supabase client directly. Those grants remain declarative, and this module does not
 * pretend otherwise: `enforceableTools()` names exactly what is covered so a test can assert
 * the gap rather than let it be mistaken for coverage. Closing it means routing persistence
 * through an injected handle too, which is a Phase 3 concern (the agent that writes the
 * report is where it starts to matter).
 *
 * ── Failure mode ────────────────────────────────────────────────────────────
 *
 * Default is `strict`: an ungranted call throws, because a tool grant is an authorization
 * boundary and §9.3 keeps those code-controlled and non-negotiable. `warn` is available for
 * a rollout where the grants are not yet trusted — it reports every violation without
 * failing the run, which is how you discover a missing grant without an outage.
 */

import { TOOLS } from '../schemas.js';
import { agentForStep } from '../registry.js';

/**
 * API route → tool. Keyed on the route segment so it works for any API base
 * (`/api/gemini`, `http://host/api/gemini`, a proxy prefix, …).
 *
 * Every LLM provider maps to the single LLM grant on purpose: which model answered is a
 * routing decision (see progressive model routing, §8.3), not a change in what the agent is
 * permitted to do. An agent granted LLM may use whichever provider the gateway picks.
 */
export const TOOL_BY_ROUTE = Object.freeze({
    gemini: TOOLS.LLM,
    claude: TOOLS.LLM,
    groq: TOOLS.LLM,
    sarvam: TOOLS.LLM,
    search: TOOLS.TAVILY,
    scrape: TOOLS.SCRAPE,
    exa: TOOLS.EXA,
    // The `collect` step reaches tenders, filings and social APIs through this route. It was
    // absent until the merge made `collect` a live step, which meant those calls bypassed
    // enforcement entirely — toolForUrl() returned null, so no grant was required.
    connectors: TOOLS.CONNECTORS,
    // Added with the route, not after: a provider route missing here is unenforced.
    jev: TOOLS.JEV,
});

/** Tools this module can actually enforce. Anything else is declaration-only — see header. */
export const enforceableTools = () => [...new Set(Object.values(TOOL_BY_ROUTE))];

/** The tool a URL implies, or null when the route is not provider-bound. */
export function toolForUrl(url) {
    if (!url) return null;
    // Take the last non-empty path segment, ignoring any query string.
    const path = String(url).split('?')[0].replace(/\/+$/, '');
    const segment = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return TOOL_BY_ROUTE[segment] ?? null;
}

export class ToolPermissionError extends Error {
    constructor(agentId, tool, url) {
        super(
            `Agent "${agentId}" called ${url} which requires tool "${tool}", but its contract does not grant it. `
            + 'Either the call belongs to a different agent, or the spec\'s allowed_tools is wrong — '
            + 'fix the contract deliberately rather than widening it to make this go away.'
        );
        this.name = 'ToolPermissionError';
        this.agentId = agentId;
        this.tool = tool;
        this.url = url;
    }
}

/**
 * Wrap a `postJson` with the grant of whichever agent owns `stepName`.
 *
 * @param {Function} postJson  the unguarded transport
 * @param {object}   opts
 * @param {string}   opts.stepName   step about to run; its owning agent supplies the grant
 * @param {'strict'|'warn'|'off'} opts.mode
 * @param {Function} [opts.onViolation]  called with ({ agentId, tool, url }) on every breach
 * @returns {Function} a drop-in replacement for postJson
 */
export function guardPostJson(postJson, { stepName, mode = 'strict', onViolation = null } = {}) {
    if (mode === 'off') return postJson;

    const agent = agentForStep(stepName);
    // An unowned step cannot be policed. The registry's own validation already fails loudly
    // on unowned steps, so this stays permissive rather than double-reporting.
    if (!agent) return postJson;

    const granted = new Set(agent.allowed_tools || []);

    return async function guardedPostJson(url, body, ...rest) {
        const tool = toolForUrl(url);

        if (tool && !granted.has(tool)) {
            const violation = { agentId: agent.id, tool, url: String(url), stepName };
            try { onViolation?.(violation); } catch { /* reporting must not mask the breach */ }

            if (mode === 'strict') throw new ToolPermissionError(agent.id, tool, url);
            console.error(
                `[agents] TOOL GRANT VIOLATION: "${agent.id}" (step "${stepName}") called ${url} `
                + `requiring "${tool}", which it does not declare. Allowed in warn mode — set `
                + 'AGENT_TOOL_ENFORCEMENT=strict to fail instead.'
            );
        }

        return postJson(url, body, ...rest);
    };
}

/** Resolve the enforcement mode from the environment. */
export function resolveToolEnforcement(raw) {
    const v = String(raw ?? 'strict').toLowerCase().trim();
    return ['strict', 'warn', 'off'].includes(v) ? v : 'strict';
}
