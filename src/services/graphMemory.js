/**
 * Track 2 memory graph — thin browser client for /api/graph.
 *
 * Browser-safe on purpose: no falkordb import (that client speaks the Redis
 * protocol and only exists server-side). Every failure mode returns null —
 * the graph being down or disabled must degrade the answer path, never break
 * the ask flow.
 */

import { postJson } from './apiClient.js';

const ANSWERED = new Set(['answered_from_memory', 'answered_with_path']);

/**
 * Ask the tenant's memory graph. Returns the structured result
 * { outcome, answer, tool_trace, paths, memory_ts } or null when the graph
 * could not be reached at all.
 */
export async function graphAsk(question) {
    try {
        const res = await postJson('/api/graph', { action: 'ask', payload: { question } });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

export const graphAnswered = (result) => Boolean(result?.ok && ANSWERED.has(result.outcome));

/**
 * One-line provenance suffix for a graph-sourced answer — names the tool, the
 * path entities, and the memory timestamp, so "this came from memory" is a
 * claim the UI can defend rather than assert.
 */
export function graphProvenanceLine(result) {
    const tools = (result?.tool_trace || []).map((t) => t.tool).filter(Boolean);
    const lastPath = (result?.paths || []).find((p) => p?.length > 1);
    const parts = [
        tools.length ? `tool: ${tools.join(' → ')}` : null,
        lastPath ? `path: ${lastPath.join(' → ')}` : null,
        result?.memory_ts ? `memory as of ${new Date(result.memory_ts).toISOString().slice(0, 10)}` : null,
    ].filter(Boolean);
    return `[via memory graph — ${parts.join(' · ') || result?.outcome}]`;
}

/**
 * The Stage-3 write-back: a confident live-search answer is recorded into the
 * tenant graph so the next identical question resolves from memory. Fire and
 * forget — never block the answer on it.
 */
export async function graphRecordFinding({ question, answer, sourceUrl }) {
    try {
        await postJson('/api/graph', {
            action: 'record_finding',
            payload: { question, answer, sourceUrl },
        });
    } catch (err) {
        console.warn('[graph] record_finding failed (answer unaffected):', err?.message);
    }
}
