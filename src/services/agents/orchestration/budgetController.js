/**
 * Budget controller — reads the run spend ledger and answers "can we still afford this?".
 *
 * Phase 0 added the ledger (recording). This adds the limits and the decision function.
 * Enforcement is still OPT-IN via BUDGET_MODE, for the same reason the verifier shipped in
 * report mode first: a control that starts silently killing runs the day it lands is worse
 * than one you switched on deliberately after watching real numbers.
 *
 * Modes:
 *   off      — no limits consulted
 *   report   — evaluate and report overruns, never stop work (default)
 *   enforce  — agents should degrade or stop when a limit is hit
 */

export const BUDGET_POLICY_VERSION = 'v1';

/**
 * Defaults are set ~4-5x above a normal run so they catch runaway loops, not ordinary work.
 * A healthy run is roughly 25-40 LLM calls and well under a dollar; observed real jobs sit
 * near 85k tokens total.
 */
export const DEFAULT_BUDGET = Object.freeze({
    max_tokens: 500_000,
    max_cost_usd: 2.0,
    max_calls: 400,
    max_wall_clock_ms: 15 * 60 * 1000,
});

export function resolveBudgetMode(env = {}) {
    const raw = String(env.BUDGET_MODE || env.VITE_BUDGET_MODE || 'report').toLowerCase().trim();
    return ['off', 'report', 'enforce'].includes(raw) ? raw : 'report';
}

function toPositiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a budget from env overrides, falling back to the defaults above. */
export function resolveBudget(env = {}) {
    return {
        max_tokens: toPositiveNumber(env.BUDGET_MAX_TOKENS, DEFAULT_BUDGET.max_tokens),
        max_cost_usd: toPositiveNumber(env.BUDGET_MAX_COST_USD, DEFAULT_BUDGET.max_cost_usd),
        max_calls: toPositiveNumber(env.BUDGET_MAX_CALLS, DEFAULT_BUDGET.max_calls),
        max_wall_clock_ms: toPositiveNumber(env.BUDGET_MAX_WALL_CLOCK_MS, DEFAULT_BUDGET.max_wall_clock_ms),
    };
}

/**
 * Evaluate a spend ledger against a budget.
 *
 * @param {object} spend  ledger from getRunSpend()
 * @param {object} [budget]
 * @returns {{ exceeded: boolean, breaches: Array, usage: object }}
 */
export function evaluateBudget(spend, budget = DEFAULT_BUDGET) {
    const usage = {
        tokens: spend?.tokens?.total ?? 0,
        cost_usd: spend?.cost_usd?.total ?? 0,
        calls: spend?.calls?.total ?? 0,
        wall_clock_ms: spend?.wall_clock_ms ?? 0,
    };

    const limits = [
        ['tokens', usage.tokens, budget.max_tokens],
        ['cost_usd', usage.cost_usd, budget.max_cost_usd],
        ['calls', usage.calls, budget.max_calls],
        ['wall_clock_ms', usage.wall_clock_ms, budget.max_wall_clock_ms],
    ];

    const breaches = limits
        .filter(([, used, cap]) => used > cap)
        .map(([name, used, cap]) => ({ limit: name, used, cap, over_by: used - cap }));

    const utilization = Object.fromEntries(
        limits.map(([name, used, cap]) => [name, cap > 0 ? Number((used / cap).toFixed(3)) : 0])
    );

    return { exceeded: breaches.length > 0, breaches, usage, utilization };
}

/**
 * Should the run keep going? In `report` mode the answer is always yes and the caller just
 * logs; only `enforce` actually stops work.
 */
export function shouldContinue(spend, { mode = 'report', budget = DEFAULT_BUDGET } = {}) {
    if (mode === 'off') return { ok: true, mode, breaches: [] };
    const result = evaluateBudget(spend, budget);
    return {
        ok: mode === 'enforce' ? !result.exceeded : true,
        mode,
        breaches: result.breaches,
        usage: result.usage,
        utilization: result.utilization,
    };
}
