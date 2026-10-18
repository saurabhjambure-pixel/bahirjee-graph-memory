/**
 * The fixed Track 2 tool catalogue — six tools, human-authored Cypher.
 *
 * The model SELECTS a tool and fills typed arguments; it never writes or edits
 * a query. Every tool shares the same pipeline:
 *
 *   validate args → resolve named entities → run capped Cypher → validate result
 *
 * Two properties the whole design depends on:
 *
 *   1. UNKNOWN ENTITY ⇒ NO QUERY. resolveEntity() runs the one small lookup a
 *      tool is allowed before its real query; a miss short-circuits with
 *      outcome 'unknown_entity' and nothing else executes.
 *   2. NOT FOUND ≠ NOT TRUE. A known entity with no connecting path returns
 *      'not_in_graph' — a fact about the graph's coverage, never interpreted
 *      as evidence of absence.
 *
 * Depth is the one value interpolated into a query string, and only after
 * integer validation against a hard cap — Cypher cannot parameterise
 * variable-length bounds, so `*1..${depth}` is spliced from a checked int,
 * never from raw caller text.
 */

import { graphRoQuery, isGraphEnabled } from './_graph.js';

const MAX_DEPTH = 4;
const MAX_ROWS = 50;
const DEFAULT_LIMIT = 25;

// Relationship families each traversal may follow. blast_radius deliberately
// includes COMPETES_WITH and MONITORS: a shared dependency IS the point — an
// AWS event lands in the radius of every company that depends on it, including
// a competitor's.
const DEPENDENCY_RELS = "DEPENDS_ON|PARTNERS_WITH|COMPETES_WITH|MONITORS|REGULATED_BY";
const MEMORY_RELS = "ABOUT|SUPPORTED_BY|CONTRADICTED_BY|TESTS|ANSWERS";

const normalizeKey = (name) => String(name || '').toLowerCase().trim();

/** falkordb node/edge values arrive as { id, labels|relationship, properties }. */
const nodeProps = (n) => n?.properties ?? n ?? {};
const nodeLabel = (n) => n?.labels?.[0] ?? nodeProps(n).label ?? null;

function summarizeNode(n) {
    const p = nodeProps(n);
    return {
        id: p.id ?? null,
        label: nodeLabel(n),
        name: p.name ?? p.headline ?? p.question ?? p.statement ?? p.id ?? null,
        ts: p.ts ?? p.observed_at ?? p.created_ts ?? null,
    };
}

/** Normalise whatever a path value deserialises to into an ordered name list. */
function summarizePath(path) {
    const nodes = Array.isArray(path?.nodes) ? path.nodes : (Array.isArray(path) ? path : []);
    return nodes.map(summarizeNode).map((n) => n.name).filter(Boolean);
}

/**
 * The pre-query gate. Entity arguments resolve against Entity AND Company
 * nodes (the founder's own company is a legal question target) by name_key —
 * the same lowercased-name keying tracked_entities uses.
 *
 * @returns entity summary, or null ⇒ caller returns 'unknown_entity' unqueried.
 */
async function resolveEntity(clientId, name) {
    const res = await graphRoQuery(
        clientId,
        `MATCH (e) WHERE (e:Entity OR e:Company) AND e.name_key = $key RETURN e LIMIT 2`,
        { key: normalizeKey(name) },
    );
    if (!res.ok) return { error: res };
    if (!res.data?.length) return { entity: null };
    return { entity: summarizeNode(res.data[0].e) };
}

/**
 * Resolution gate exposed for the agent loop's forced-recall path: returns the
 * entity summary or null, with graph errors normalised away (a failed lookup
 * is treated as "no hint", never a crash).
 */
export async function probeEntity(clientId, name) {
    const r = await resolveEntity(clientId, name);
    if (r.error) return null;
    return r.entity;
}

/**
 * Entity hints from free text: try each capitalised phrase first ("State
 * PowerGrid"), then fall back to its words ("PowerGrid") — a leading
 * capitalised non-entity like "Does ShipSwift" must not swallow the real
 * entity inside it. Used by the writer (entity anchoring) and the agent
 * (forced-recall hint). Returns up to `max` resolved entities.
 */
export async function probeQuestionEntities(clientId, text, { max = 2 } = {}) {
    const phrases = String(text).match(/\b[A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)*\b/g) || [];
    const found = [];
    for (const phrase of phrases.slice(0, 6)) {
        for (const cand of [phrase, ...phrase.split(' ')]) {
            const ent = await probeEntity(clientId, cand);
            if (!ent?.id) continue;
            if (!found.some((f) => f.id === ent.id)) found.push(ent);
            break; // phrase resolved at some granularity — don't double-add parts
        }
        if (found.length >= max) break;
    }
    return found.slice(0, max);
}

const unknownEntity = (tool, entity) =>
    ({ ok: true, outcome: 'unknown_entity', tool, entity, queried: false, nodes: [], path: [] });
const notInGraph = (tool, extra = {}) =>
    ({ ok: true, outcome: 'not_in_graph', tool, nodes: [], path: [], ...extra });

function isInt(v, lo, hi) {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

// ─── Tool: recall ────────────────────────────────────────────────────────────
// What does the graph already know about this entity — prior findings, reads,
// beliefs and the evidence under them. Must run before live search when the
// question references prior work.
async function recall(clientId, { entity }) {
    const r = await resolveEntity(clientId, entity);
    if (r.error) return r.error;
    if (!r.entity) return unknownEntity('recall', entity);

    const res = await graphRoQuery(
        clientId,
        `MATCH (e {id: $id})
         MATCH p = (x)-[:${MEMORY_RELS}*1..2]-(e)
         WHERE x:Finding OR x:Read OR x:Belief OR x:Evidence OR x:Question
         RETURN x, p LIMIT $limit`,
        { id: r.entity.id, limit: MAX_ROWS },
    );
    if (!res.ok) return res;

    const nodes = (res.data || []).map((row) => summarizeNode(row.x));
    if (!nodes.length) return notInGraph('recall', { entity: r.entity.name });
    return {
        ok: true,
        outcome: 'answered_from_memory',
        tool: 'recall',
        entity: r.entity.name,
        nodes,
        paths: (res.data || []).map((row) => summarizePath(row.p)).filter((p) => p.length),
        memory_ts: Math.max(...nodes.map((n) => Number(n.ts) || 0), 0) || null,
    };
}

// ─── Tool: blast_radius ──────────────────────────────────────────────────────
// Who is downstream of this entity — bounded dependency traversal returning
// complete paths so callers see every intermediate hop.
async function blastRadius(clientId, { entity, depth = 2 }) {
    const d = isInt(depth, 1, MAX_DEPTH);
    if (d === null) return { ok: false, error: `depth must be an integer 1-${MAX_DEPTH}` };

    const r = await resolveEntity(clientId, entity);
    if (r.error) return r.error;
    if (!r.entity) return unknownEntity('blast_radius', entity);

    const res = await graphRoQuery(
        clientId,
        `MATCH (e {id: $id})
         MATCH p = (e)-[:${DEPENDENCY_RELS}*1..${d}]-(x)
         RETURN p LIMIT $limit`,
        { id: r.entity.id, limit: MAX_ROWS },
    );
    if (!res.ok) return res;

    const paths = (res.data || []).map((row) => summarizePath(row.p)).filter((p) => p.length > 1);
    if (!paths.length) return notInGraph('blast_radius', { entity: r.entity.name, depth: d });
    return {
        ok: true,
        outcome: 'answered_with_path',
        tool: 'blast_radius',
        entity: r.entity.name,
        depth: d,
        paths,
        truncated: (res.data || []).length >= MAX_ROWS,
    };
}

// ─── Tool: next_agent ────────────────────────────────────────────────────────
// Coordination: pending handoffs concerning work about this entity, and the
// agent each is addressed TO.
async function nextAgent(clientId, { entity }) {
    const r = await resolveEntity(clientId, entity);
    if (r.error) return r.error;
    if (!r.entity) return unknownEntity('next_agent', entity);

    const res = await graphRoQuery(
        clientId,
        `MATCH (e {id: $id})<-[:ABOUT]-(work)<-[:CONCERNS]-(h:Handoff {status: 'pending'})
         MATCH (h)-[:FROM]->(fromAgt:Agent), (h)-[:TO]->(toAgt:Agent)
         RETURN h, work, fromAgt, toAgt LIMIT 3`,
        { id: r.entity.id },
    );
    if (!res.ok) return res;

    const rows = res.data || [];
    if (!rows.length) return notInGraph('next_agent', { entity: r.entity.name });
    return {
        ok: true,
        outcome: 'answered_with_path',
        tool: 'next_agent',
        entity: r.entity.name,
        handoffs: rows.map((row) => ({
            handoff: summarizeNode(row.h),
            work: summarizeNode(row.work),
            from: nodeProps(row.fromAgt).name ?? null,
            to: nodeProps(row.toAgt).name ?? null,
        })),
    };
}

// ─── Tool: recent_changes ────────────────────────────────────────────────────
// What moved lately about this entity — Finding/Evidence/Read nodes newer than
// `since` (epoch ms, or an ISO date string the caller typed).
async function recentChanges(clientId, { entity, since }) {
    const r = await resolveEntity(clientId, entity);
    if (r.error) return r.error;
    if (!r.entity) return unknownEntity('recent_changes', entity);

    let sinceMs = Number(since);
    if (!Number.isFinite(sinceMs)) sinceMs = Date.parse(String(since || ''));
    if (!Number.isFinite(sinceMs)) sinceMs = Date.now() - 7 * 86400000; // default: last week

    const res = await graphRoQuery(
        clientId,
        `MATCH (e {id: $id})<-[:ABOUT]-(n)
         WHERE (n:Finding OR n:Evidence OR n:Read)
           AND coalesce(n.ts, n.observed_at, n.created_ts, 0) >= $since
         RETURN n LIMIT $limit`,
        { id: r.entity.id, since: sinceMs, limit: MAX_ROWS },
    );
    if (!res.ok) return res;

    const nodes = (res.data || []).map((row) => summarizeNode(row.n));
    if (!nodes.length) return notInGraph('recent_changes', { entity: r.entity.name, since: sinceMs });
    return { ok: true, outcome: 'answered_from_memory', tool: 'recent_changes', entity: r.entity.name, since: sinceMs, nodes };
}

// ─── Tool: path_between ──────────────────────────────────────────────────────
// The actual shortest path between two known entities — FalkorDB's
// algo.SPpaths, not a hand-rolled BFS.
async function pathBetween(clientId, { from_entity, to_entity }) {
    const [a, b] = await Promise.all([resolveEntity(clientId, from_entity), resolveEntity(clientId, to_entity)]);
    if (a.error) return a.error;
    if (b.error) return b.error;
    if (!a.entity) return unknownEntity('path_between', from_entity);
    if (!b.entity) return unknownEntity('path_between', to_entity);

    const res = await graphRoQuery(
        clientId,
        `MATCH (s {id: $a}), (t {id: $b})
         CALL algo.SPpaths({sourceNode: s, targetNode: t,
                            relTypes: ['DEPENDS_ON', 'PARTNERS_WITH', 'COMPETES_WITH', 'MONITORS', 'REGULATED_BY'],
                            undirected: true, pathCount: 3, maxLen: 6})
         YIELD path RETURN path LIMIT $limit`,
        { a: a.entity.id, b: b.entity.id, limit: DEFAULT_LIMIT },
    );
    if (!res.ok) return res;

    const paths = (res.data || []).map((row) => summarizePath(row.path)).filter((p) => p.length);
    if (!paths.length) return notInGraph('path_between', { from: a.entity.name, to: b.entity.name });
    return {
        ok: true,
        outcome: 'answered_with_path',
        tool: 'path_between',
        from: a.entity.name,
        to: b.entity.name,
        paths,
    };
}

// ─── Tool: load_bearing ──────────────────────────────────────────────────────
// PageRank over the tenant graph — which entities are structurally load-bearing.
async function loadBearing(clientId, { limit = 10 }) {
    const n = isInt(limit, 1, MAX_ROWS) ?? DEFAULT_LIMIT;
    const res = await graphRoQuery(
        clientId,
        `CALL algo.pageRank(NULL, NULL) YIELD node, score
         WITH node, score WHERE node:Entity
         RETURN node, score ORDER BY score DESC LIMIT $limit`,
        { limit: n },
    );
    if (!res.ok) return res;

    const ranked = (res.data || []).map((row) => ({ ...summarizeNode(row.node), score: row.score }));
    if (!ranked.length) return notInGraph('load_bearing');
    return { ok: true, outcome: 'answered_with_path', tool: 'load_bearing', ranked };
}

// ─── Catalogue + dispatcher ──────────────────────────────────────────────────

export const GRAPH_TOOLS = Object.freeze({
    recall: { run: recall, args: ['entity'] },
    blast_radius: { run: blastRadius, args: ['entity', 'depth?'] },
    next_agent: { run: nextAgent, args: ['entity'] },
    recent_changes: { run: recentChanges, args: ['entity', 'since?'] },
    path_between: { run: pathBetween, args: ['from_entity', 'to_entity'] },
    load_bearing: { run: loadBearing, args: ['limit?'] },
});

export const isGraphTool = (name) => Object.hasOwn(GRAPH_TOOLS, name);

/**
 * Typed dispatch. Unknown tool names and missing required args are rejected
 * BEFORE any entity resolution runs — the model cannot invent a tool.
 */
export async function runGraphTool(clientId, toolName, args = {}) {
    if (!isGraphEnabled()) return { ok: false, outcome: 'graph_unavailable' };
    const tool = GRAPH_TOOLS[toolName];
    if (!tool) return { ok: false, error: `unknown_tool:${toolName}` };

    const missing = tool.args
        .filter((a) => !a.endsWith('?') && (args[a] === undefined || args[a] === null || args[a] === ''));
    if (missing.length) return { ok: false, error: `missing_args:${missing.join(',')}` };

    return tool.run(clientId, args);
}
