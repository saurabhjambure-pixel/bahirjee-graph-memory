/**
 * The Track 2 graph agent — a bounded Reason → Tool → Observe → Answer loop.
 *
 * Invariants, all enforced here rather than trusted to the model:
 *
 *   - HARD STEP CAP: at most maxGraphSteps() tool calls per question, default
 *     4 (MEMORY_GRAPH_MAX_STEPS). The loop physically cannot spend a fifth.
 *   - NO INVENTED TOOLS: runGraphTool rejects any name outside the catalogue.
 *   - NO INVENTED CLAIMS: a finished answer is checked against the nodes that
 *     actually came back — an answer naming an entity no tool returned is
 *     rejected and replaced by the honest outcome.
 *   - RECALL FIRST: when the question references prior work, recall runs before
 *     whatever the model picked, and counts against the step budget.
 *   - HONEST ABSENCE: not_in_graph and unknown_entity are terminal answers,
 *     not triggers to guess.
 *
 * The LLM call goes through the internal route client — the same in-process
 * dispatch the stepped worker uses — so the gemini gateway's schema, retry and
 * provenance machinery applies to graphAgentStep like every other action.
 */

import { maxGraphSteps, isGraphEnabled } from './_graph.js';
import { runGraphTool, isGraphTool, probeEntity, probeQuestionEntities } from './_graphTools.js';
import { internalPostJson } from './_internalRouteClient.js';

const PRIOR_WORK_RE = /\b(last time|before|earlier|previous|previously|history|already|again|still|remember|recall|what did we|what have we|known about)\b/i;

const TERMINAL_OUTCOMES = new Set(['unknown_entity', 'not_in_graph', 'graph_unavailable']);

/** Every node name/id a tool result surfaced — the answer's allowed vocabulary. */
function collectVocabulary(results) {
    const vocab = new Set();
    const add = (s) => { if (s) vocab.add(String(s).toLowerCase()); };
    for (const r of results) {
        if (!r?.ok) continue;
        add(r.entity); add(r.from); add(r.to);
        for (const n of r.nodes || []) { add(n?.name); add(n?.id); }
        for (const n of r.ranked || []) { add(n?.name); add(n?.id); }
        for (const p of r.paths || []) for (const name of p || []) add(name);
        for (const h of r.handoffs || []) { add(h?.from); add(h?.to); add(h?.work?.name); }
    }
    return vocab;
}

/**
 * Grounding check on the model's final answer. The answer may only assert
 * about entities the graph actually returned — this catches the failure shape
 * "the tool said not_in_graph and the model answered anyway". A name that is
 * absent from the vocabulary AND looks like a proper noun (capitalised, ≥2
 * chars, not a common English word the prompt itself uses) fails the check.
 */
export function answerIsGrounded(answer, vocab) {
    if (!answer || !String(answer).trim()) return false;
    // Capitalised multi-word-ish tokens are the only way a hallucinated entity
    // reaches the founder. Numbers/dates/quotes pass — they are attributes of
    // returned nodes, not entities.
    const candidates = String(answer).match(/\b[A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)*\b/g) || [];
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'its', 'i', 'we', 'this', 'that', 'there', 'aws', 'no', 'not', 'your', 'you']);
    const offending = candidates
        .map((c) => c.trim())
        .filter((c) => c.length > 1 && !STOP.has(c.toLowerCase()))
        .filter((c) => !vocab.has(c.toLowerCase()));
    return offending.length === 0;
}

async function agentStepLlm(payload) {
    const res = await internalPostJson('/api/gemini', { action: 'graphAgentStep', payload });
    if (!res.ok) throw new Error(`graphAgentStep call failed: HTTP ${res.status}`);
    return res.json();
}

/**
 * Answer a founder's question from the tenant graph.
 *
 * @param {string} clientId  tenant id (resolved server-side from auth — the
 *                           graph name is derived from it and nothing else)
 * @param {string} question  the founder's question
 * @returns {Promise<{outcome, answer, tool_trace, paths, memory_ts, steps}>}
 */
export async function askGraph(clientId, question, deps = {}) {
    const stepFn = deps.stepFn || agentStepLlm;
    if (!isGraphEnabled()) {
        return { ok: false, outcome: 'graph_unavailable', answer: null, tool_trace: [], paths: [] };
    }
    const maxSteps = maxGraphSteps();
    const observations = [];
    const toolResults = [];
    const toolTrace = [];
    const paths = [];

    // Recall-first: if the question references prior work, memory answers it
    // before any other tool — and the step counts, like any other tool call.
    // The entity is probed from the question's capitalised tokens (no extra LLM
    // call); an unknown name still returns unknown_entity from recall itself.
    if (PRIOR_WORK_RE.test(question)) {
        const probe = await probeQuestionEntity(clientId, question);
        if (probe) {
            const recalled = await runGraphTool(clientId, 'recall', { entity: probe.name || probe });
            toolTrace.push({ step: 0, tool: 'recall', args: { entity: probe.name || probe }, outcome: recalled.outcome, forced: true });
            toolResults.push(recalled);
            observations.push(summarizeResult(recalled));
            for (const p of recalled.paths || []) paths.push(p);
        }
    }

    for (let step = toolTrace.length; step < maxSteps; step++) {
        let decision;
        try {
            decision = await stepFn({
                question, observations, stepsUsed: toolTrace.length, maxSteps,
            });
        } catch (err) {
            console.warn('[graph-agent] step call failed:', err.message);
            break;
        }

        if (decision?.done) {
            const answer = String(decision.answer || '').trim();
            const vocab = collectVocabulary(toolResults);
            if (!answerIsGrounded(answer, vocab)) {
                // The model answered from its own head. That is exactly the
                // failure the catalogue exists to prevent — report the honest
                // outcome rather than ship an ungrounded sentence.
                return finalize(toolResults, toolTrace, paths, {
                    forcedOutcome: toolResults.length ? null : 'not_in_graph',
                    note: 'answer rejected: named entities not present in graph results',
                });
            }
            return finalize(toolResults, toolTrace, paths, { answer });
        }

        const tool = normalizeToolName(decision?.tool);
        if (!tool) {
            // An invented tool name costs a step — that is the guard, not a crash.
            toolTrace.push({ step, tool: String(decision?.tool || '(none)'), args: {}, outcome: 'unknown_tool' });
            observations.push({ error: `no such tool: ${String(decision?.tool || '')}` });
            continue;
        }

        // Arg hydration: if the model left entity args empty, resolve them
        // from the question text. A lazy light model must not be able to
        // starve the loop — and an entity it can't name still resolves or
        // fails unknown_entity inside the tool, never silently succeeds.
        const args = await hydrateArgs(clientId, tool, decision.args || {}, question);
        const result = await runGraphTool(clientId, tool, args);
        toolTrace.push({ step, tool, args, outcome: result.outcome || (result.ok ? 'ok' : 'error') });
        toolResults.push(result);
        observations.push(summarizeResult(result));
        for (const p of result.paths || []) paths.push(p);

        // Terminal outcomes end the loop — there is no second tool that makes
        // an unknown entity known or a missing path appear.
        if (TERMINAL_OUTCOMES.has(result.outcome)) break;
    }

    return finalize(toolResults, toolTrace, paths, {});
}

/**
 * Best-effort entity hint for the forced recall: try the question's
 * capitalised tokens against the graph's name_key index. A miss costs one tiny
 * lookup per token and simply means "no hint" — the model still gets to pick
 * recall's entity itself.
 */
async function probeQuestionEntity(clientId, question) {
    const hits = await probeQuestionEntities(clientId, question, { max: 1 });
    return hits[0] || null;
}

/**
 * Light models sometimes think aloud inside the tool field
 * ("recall — because...", "blast_radiuschain_or..."). Recover intent: a raw
 * value that starts with (or contains) a catalogue name maps to that tool;
 * anything else stays an invented-tool rejection. Catalogue names are
 * deliberately not prefixes of one another, so this is unambiguous.
 */
const CATALOGUE_NAMES = ['blast_radius', 'recent_changes', 'path_between', 'next_agent', 'load_bearing', 'recall'];
function normalizeToolName(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (isGraphTool(s)) return s;
    const lower = s.toLowerCase();
    for (const name of CATALOGUE_NAMES) {
        if (lower.startsWith(name)) return name;
    }
    for (const name of CATALOGUE_NAMES) {
        if (lower.includes(name)) return name;
    }
    return null;
}

/**
 * Fill entity args the model omitted. Entity values come from probing the
 * question against the name_key index — never free text from the model, so a
 * hallucinated arg still fails the tool's own resolution gate.
 */
async function hydrateArgs(clientId, tool, args, question) {
    const entityTools = ['recall', 'blast_radius', 'next_agent', 'recent_changes'].includes(tool);
    if (!entityTools && tool !== 'path_between') return args;

    // Verify a model-supplied entity actually resolves via the exact name_key
    // lookup; if it doesn't (the model passed "ShipSwift pricing change" as a
    // name), the question's own probed entities are the fallback — never free
    // text passed on trust.
    const verify = async (name) => {
        if (!name) return null;
        const ent = await probeEntity(clientId, name);
        return ent?.id ? name : null;
    };
    const needsEntity = entityTools && !(await verify(args.entity));
    const needsFrom = tool === 'path_between' && !(await verify(args.from_entity));
    const needsTo = tool === 'path_between' && !(await verify(args.to_entity));
    if (!needsEntity && !needsFrom && !needsTo) return args;

    const hits = await probeQuestionEntities(clientId, question, { max: 2 });
    if (!hits.length) return args;

    const hydrated = { ...args };
    if (needsEntity) hydrated.entity = hits[0].name;
    if (tool === 'path_between') {
        if (needsFrom) hydrated.from_entity = hits[0].name;
        if (needsTo) {
            const other = hits.find((h) => h.name !== hydrated.from_entity);
            if (other) hydrated.to_entity = other.name;
        }
    }
    return hydrated;
}

function summarizeResult(r) {
    if (!r?.ok) return { outcome: r?.outcome || 'error', error: r?.error || null };
    return {
        outcome: r.outcome,
        tool: r.tool,
        entity: r.entity || null,
        nodes: (r.nodes || []).slice(0, 15),
        ranked: (r.ranked || []).slice(0, 15),
        handoffs: (r.handoffs || []).slice(0, 3),
        paths: (r.paths || []).slice(0, 10),
    };
}

/**
 * Compose the final response. The outcome is DERIVED from what the tools
 * returned — never from the model's say-so:
 *   any answered_with_path result        → answered_with_path
 *   any answered_from_memory result      → answered_from_memory
 *   all terminal not_in_graph            → not_in_graph
 *   unknown_entity and nothing else      → unknown_entity
 */
function finalize(toolResults, toolTrace, paths, { answer = null, forcedOutcome = null, note = null }) {
    const outcomes = toolResults.filter((r) => r?.ok).map((r) => r.outcome);
    let outcome = forcedOutcome;
    if (!outcome) {
        if (outcomes.includes('answered_with_path')) outcome = 'answered_with_path';
        else if (outcomes.includes('answered_from_memory')) outcome = 'answered_from_memory';
        else if (outcomes.length && outcomes.every((o) => o === 'not_in_graph')) outcome = 'not_in_graph';
        else if (outcomes.includes('unknown_entity')) outcome = 'unknown_entity';
        else outcome = 'not_in_graph';
    }

    const memoryTs = toolResults
        .map((r) => Number(r?.memory_ts) || Math.max(0, ...(r?.nodes || []).map((n) => Number(n?.ts) || 0)))
        .reduce((m, v) => Math.max(m, v), 0) || null;

    // The model's prose was rejected or absent but real evidence exists —
    // describe what the tools actually returned rather than "could not compose".
    let fallbackAnswer = describeOutcome(outcome, toolResults);
    if (outcome === 'answered_with_path') {
        const handoffs = toolResults.flatMap((r) => r?.handoffs || []);
        const ranked = toolResults.flatMap((r) => r?.ranked || []);
        if (paths.length) {
            fallbackAnswer = `The graph shows this connection: ${paths[0].join(' → ')}.`;
        } else if (handoffs.length) {
            const h = handoffs[0];
            fallbackAnswer = `Pending handoff: ${h.from} → ${h.to}${h.work?.name ? ` — ${h.work.name}` : ''}.`;
        } else if (ranked.length) {
            fallbackAnswer = `The most load-bearing entities in this graph: ${ranked.slice(0, 4).map((e) => e.name).join(', ')}.`;
        }
    } else if (outcome === 'answered_from_memory') {
        const names = toolResults.flatMap((r) => r?.nodes || []).map((n) => n?.name).filter(Boolean).slice(0, 4);
        if (names.length) fallbackAnswer = `Memory holds: ${names.join(' · ')}.`;
    }

    return {
        ok: true,
        outcome,
        answer: answer || fallbackAnswer,
        tool_trace: toolTrace,
        paths,
        memory_ts: memoryTs,
        steps: toolTrace.length,
        ...(note ? { note } : {}),
    };
}

/** Plain-language stand-in when the loop ends without a model answer. */
function describeOutcome(outcome, results) {
    const ent = results.find((r) => r?.entity)?.entity;
    switch (outcome) {
        case 'not_in_graph':
            return ent
                ? `I know ${ent}, but the memory graph holds no connected evidence for this question yet.`
                : 'The memory graph holds no connected evidence for this question yet.';
        case 'unknown_entity':
            return 'That name is not in this company\'s tracked entities — I did not run a graph query.';
        case 'graph_unavailable':
            return 'The memory graph is not available right now.';
        default:
            return 'I found memory for this question but could not compose an answer from it.';
    }
}
