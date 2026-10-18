/**
 * FalkorDB connection layer — Track 2 memory & coordination graph.
 *
 * One named graph per tenant: `bahirjee:{client_id}`. The name is derived HERE
 * from a validated client_id — callers pass a client_id, never a graph name, so
 * there is no code path on which a request parameter can reach a graph it should
 * not. Tenant isolation is the graph boundary itself.
 *
 * Failure posture, same as agentRunStore: the graph is additive Track 2 state,
 * never a reason the product breaks. Every helper returns a result object
 * ({ ok, outcome }) instead of throwing; MEMORY_GRAPH_ENABLED=0 makes all of
 * them no-op with outcome 'graph_unavailable' — the removal test the demo
 * depends on is just the disabled path being honest.
 *
 * The LLM never touches this file's output directly in a way that could carry
 * Cypher: tools in _graphTools.js hold the human-authored queries and call
 * graphQuery/graphRoQuery with $params only.
 *
 * Server-side only — this file lives in lib/ and imports the falkordb client,
 * which must never be bundled into the browser.
 */

import { FalkorDB } from 'falkordb';

const CONNECT_TIMEOUT_MS = Number(process.env.FALKORDB_CONNECT_TIMEOUT_MS || 4000);
const QUERY_TIMEOUT_MS = Number(process.env.FALKORDB_QUERY_TIMEOUT_MS || 8000);

/** Node labels in the tenant graph. Written by the writer, read by the tools. */
export const GRAPH_LABELS = Object.freeze([
    'Company', 'Entity', 'Evidence', 'Belief', 'Question',
    'Finding', 'Read', 'Agent', 'Session', 'Handoff',
]);

export const GRAPH_OUTCOMES = Object.freeze([
    'answered_with_path', 'answered_from_memory', 'not_in_graph',
    'unknown_entity', 'graph_unavailable',
]);

export function isGraphEnabled() {
    const flag = String(process.env.MEMORY_GRAPH_ENABLED || '').trim().toLowerCase();
    return flag === '1' || flag === 'true';
}

export function maxGraphSteps() {
    const n = Number(process.env.MEMORY_GRAPH_MAX_STEPS || 4);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 8) : 4;
}

const unavailable = (error = null) => ({
    ok: false,
    outcome: 'graph_unavailable',
    error: error ? String(error.message || error) : 'disabled_or_unconfigured',
});

const ok = (data, metadata = null) => ({ ok: true, data: data || [], metadata });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONLY place a graph name is minted. A non-UUID client_id throws — a bad
 * tenant id must fail closed, because a malformed name is how a request would
 * address a graph that is not its own.
 */
export function graphNameFor(clientId) {
    const id = String(clientId || '').trim().toLowerCase();
    if (!UUID_RE.test(id)) throw new Error('graphNameFor: client_id must be a UUID');
    return `bahirjee:${id}`;
}

// One client per warm process. Serverless invocations reuse it; a dead
// connection resets the cache so the next call reconnects rather than failing
// every request until cold start.
let _client = null;
let _clientErrorLogged = false;

async function getClient() {
    if (_client) return _client;

    const url = process.env.FALKORDB_URL || 'falkor://localhost:6379';
    const client = await FalkorDB.connect({
        url,
        username: process.env.FALKORDB_USERNAME || undefined,
        password: process.env.FALKORDB_PASSWORD || undefined,
        socket: { connectTimeout: CONNECT_TIMEOUT_MS },
    });
    client.on('error', (err) => {
        if (!_clientErrorLogged) {
            _clientErrorLogged = true;
            console.warn('[graph] FalkorDB connection error:', err.message);
        }
    });
    _client = client;
    return _client;
}

async function resetClient() {
    const c = _client;
    _client = null;
    if (c) try { await c.close(); } catch { /* already dead */ }
}

/**
 * TEST SEAM ONLY. Lets scripts/graph-roundtrip.test.mjs install a fake client
 * (same shape: selectGraph(name) → { query, roQuery }) without a live FalkorDB.
 * Production code never calls this.
 */
export function __setGraphClientForTests(clientOrNull) {
    _client = clientOrNull;
    _clientErrorLogged = false;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

async function runCypher(clientId, cypher, params, { readOnly = false } = {}) {
    if (!isGraphEnabled()) return unavailable();
    let name;
    try {
        name = graphNameFor(clientId);
    } catch (err) {
        return { ok: false, outcome: 'unknown_entity', error: err.message };
    }
    try {
        const client = await withTimeout(getClient(), CONNECT_TIMEOUT_MS + 1000, 'graph connect');
        const graph = client.selectGraph(name);
        const fn = readOnly ? 'roQuery' : 'query';
        const res = await withTimeout(
            graph[fn](cypher, { params }),
            QUERY_TIMEOUT_MS,
            'graph query',
        );
        return ok(res.data, res.metadata);
    } catch (err) {
        console.warn('[graph] query failed:', err.message);
        await resetClient(); // a poisoned connection must not fail every call
        return unavailable(err);
    }
}

/** Read-write query. All Cypher is human-authored; values travel as $params. */
export const graphQuery = (clientId, cypher, params = {}) =>
    runCypher(clientId, cypher, params, { readOnly: false });

/** Read-only query. */
export const graphRoQuery = (clientId, cypher, params = {}) =>
    runCypher(clientId, cypher, params, { readOnly: true });

/**
 * Per-tenant bootstrap: a unique constraint on `id` per label (MERGE keys) plus
 * the lookup indexes the tools need. Idempotent — FalkorDB ignores a constraint
 * or index that already exists.
 */
export async function ensureSchema(clientId) {
    if (!isGraphEnabled()) return unavailable();
    const name = graphNameFor(clientId);
    let client;
    try {
        client = await withTimeout(getClient(), CONNECT_TIMEOUT_MS + 1000, 'graph connect');
    } catch (err) {
        await resetClient();
        return unavailable(err);
    }

    // Constraints are a MODULE command, not Cypher — the client exposes
    // graph.constraintCreate() which issues GRAPH.CONSTRAINT CREATE for us.
    const graph = client.selectGraph(name);
    for (const label of GRAPH_LABELS) {
        try {
            await graph.constraintCreate('UNIQUE', 'NODE', label, 'id');
        } catch (err) {
            // 'already exists' is the idempotent path; anything else is a warning —
            // MERGE still works, constraint is belt-and-braces.
            if (!/already/i.test(err.message)) {
                console.warn(`[graph] constraint ${label}: ${err.message}`);
            }
        }
    }

    const createIdx = (cypher) => graphQuery(clientId, cypher);
    for (const label of GRAPH_LABELS) {
        const idx = await createIdx(`CREATE INDEX FOR (n:${label}) ON (n.id)`);
        if (!idx.ok && !/already/i.test(idx.error || '')) return idx;
    }
    // Entity name resolution backs the unknown_entity gate — it must stay fast.
    const nameIdx = await createIdx('CREATE INDEX FOR (e:Entity) ON (e.name_key)');
    return nameIdx.ok || /already/i.test(nameIdx.error || '') ? { ok: true, data: [] } : nameIdx;
}

/** Smoke check: is the configured instance reachable? Used by seed + tests. */
export async function graphPing() {
    if (!isGraphEnabled()) return unavailable();
    try {
        const client = await withTimeout(getClient(), CONNECT_TIMEOUT_MS + 1000, 'graph connect');
        const graphs = await client.list();
        return { ok: true, data: { graphs } };
    } catch (err) {
        await resetClient();
        return unavailable(err);
    }
}
