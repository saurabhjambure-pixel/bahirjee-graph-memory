/**
 * Direct graph writes — Track 2 memory & coordination.
 *
 * Called at the moment the system learns, observes, asks, or hands off work.
 * NOT a batch projection: these are the live writes the hackathon track exists
 * to demonstrate. (The seed script is the only exception, and it is labelled
 * synthetic.)
 *
 * Same contract as agentRunStore: telemetry-adjacent, fail-open. A graph write
 * failure must never break a run, a cron, or an answer — every helper logs a
 * warning and returns null. When MEMORY_GRAPH_ENABLED=0 every write is a no-op
 * (the removal test path).
 *
 * SECURITY NOTE: node labels and relationship types are interpolated into
 * Cypher strings (MERGE can't parameterise them), so BOTH are validated
 * against fixed whitelists here. All values travel as $params.
 */

import { randomUUID } from 'node:crypto';
import { graphQuery, isGraphEnabled, GRAPH_LABELS } from './_graph.js';
import { probeQuestionEntities } from './_graphTools.js';

const NODE_LABELS = new Set(GRAPH_LABELS);

const REL_TYPES = new Set([
    'MONITORS', 'DEPENDS_ON', 'COMPETES_WITH', 'PARTNERS_WITH', 'REGULATED_BY',
    'ABOUT', 'SUPPORTED_BY', 'CONTRADICTED_BY', 'SUPERSEDES',
    'TESTS', 'ANSWERS', 'CONCERNS', 'FROM', 'TO', 'BY',
]);

const nameKey = (name) => String(name || '').toLowerCase().trim();

async function mergeNode(clientId, label, id, props) {
    if (!isGraphEnabled()) return null;
    if (!NODE_LABELS.has(label)) {
        console.warn(`[graph-write] refused unknown label "${label}"`);
        return null;
    }
    const res = await graphQuery(
        clientId,
        `MERGE (n:${label} {id: $id}) SET n += $props`,
        { id, props: { tenant: clientId, ...props } },
    );
    if (!res.ok) {
        console.warn(`[graph-write] mergeNode ${label}:${id} failed: ${res.error || res.outcome}`);
        return null;
    }
    return id;
}

async function mergeEdge(clientId, fromId, rel, toId, props = {}) {
    if (!isGraphEnabled()) return null;
    if (!REL_TYPES.has(rel)) {
        console.warn(`[graph-write] refused unknown rel "${rel}"`);
        return null;
    }
    const res = await graphQuery(
        clientId,
        `MATCH (a {id: $a}), (b {id: $b}) MERGE (a)-[r:${rel}]->(b) SET r += $props`,
        { a: fromId, b: toId, props },
    );
    if (!res.ok) {
        console.warn(`[graph-write] edge ${fromId}-[${rel}]->${toId} failed: ${res.error || res.outcome}`);
        return null;
    }
    return true;
}

/** Canonical ids: prefix + stable upstream id, so the same fact re-merges. */
export const graphIds = {
    company: (clientId) => `co:${clientId}`,
    entity: (entityId) => `ent:${entityId}`,
    agent: (name) => `agt:${name}`,
    question: (questionId) => `q:${questionId}`,
    read: (readId) => `read:${readId}`,
    finding: (seed) => `fnd:${seed}`,
    evidence: (seed) => `ev:${seed}`,
    session: (seed) => `sess:${seed}`,
    handoff: (seed) => `ho:${seed}`,
};

/** The tenant's own company node — anchor for MONITORS/DEPENDS_ON edges. */
export async function graphWriteCompany(clientId, { name = null, domain = null } = {}) {
    const id = graphIds.company(clientId);
    // Only set name/domain when actually provided — a bare ensure-exists call
    // must not overwrite a richer name already on the node (MERGE+SET clobbers).
    const props = {};
    const display = name || domain;
    if (display) { props.name = display; props.name_key = nameKey(display); }
    if (domain) props.domain = domain;
    return mergeNode(clientId, 'Company', id, props);
}

/** A tracked entity — merged, so repeat sightings update rather than duplicate. */
export async function graphWriteEntity(clientId, { entityId, name, category = null }) {
    const id = graphIds.entity(entityId || nameKey(name));
    const nodeId = await mergeNode(clientId, 'Entity', id, {
        name, name_key: nameKey(name), category,
    });
    if (!nodeId) return null;
    // Monitored-by-the-company is the edge every entity gets.
    await mergeEdge(clientId, graphIds.company(clientId), 'MONITORS', nodeId);
    return nodeId;
}

/** The three ladder-rung agents. MERGE makes repeat calls free. */
export async function graphEnsureAgents(clientId) {
    for (const [name, role] of [['watcher', 'sense'], ['triage', 'triage'], ['pursuer', 'pursue']]) {
        await mergeNode(clientId, 'Agent', graphIds.agent(name), { name, role });
    }
}

/** One daily-ladder firing or one pipeline run — who acted, when. */
export async function graphWriteSession(clientId, { sessionId, kind, agent }) {
    const id = await mergeNode(clientId, 'Session', graphIds.session(sessionId), {
        kind, started_ts: Date.now(),
    });
    if (id && agent) await mergeEdge(clientId, id, 'BY', graphIds.agent(agent));
    return id;
}

/**
 * A watcher observation: the change, the page it came from, and the entity it
 * is ABOUT. entityId should be the tracked_entities row id when known.
 */
export async function graphWriteFinding(clientId, {
    seed, headline, entityId, entityName, url, sourceType = null, observedAt = null,
}) {
    const ts = observedAt || Date.now();
    const entityNode = entityName
        ? await graphWriteEntity(clientId, { entityId, name: entityName })
        : null;

    const evidenceId = url ? graphIds.evidence(seed) : null;
    if (evidenceId) {
        await mergeNode(clientId, 'Evidence', evidenceId, { url, ts, provenance: sourceType || 'source_watch' });
        if (entityNode) await mergeEdge(clientId, evidenceId, 'ABOUT', entityNode);
    }

    const findingId = await mergeNode(clientId, 'Finding', graphIds.finding(seed), {
        headline, observed_at: ts, ts, provenance: sourceType || 'source_watch',
    });
    if (findingId && entityNode) await mergeEdge(clientId, findingId, 'ABOUT', entityNode);
    return findingId;
}

/** A coordination handoff between two ladder agents, about a finding. */
export async function graphWriteHandoff(clientId, { seed, fromAgent, toAgent, findingId, reason, status = 'pending' }) {
    await graphEnsureAgents(clientId);
    const id = await mergeNode(clientId, 'Handoff', graphIds.handoff(seed), {
        status, reason: reason || null, created_ts: Date.now(), ts: Date.now(),
    });
    if (!id) return null;
    await mergeEdge(clientId, id, 'FROM', graphIds.agent(fromAgent));
    await mergeEdge(clientId, id, 'TO', graphIds.agent(toAgent));
    if (findingId) await mergeEdge(clientId, id, 'CONCERNS', findingId);
    return id;
}

/** Mark a pending handoff consumed — the "to" agent took the work. */
export async function graphCompleteHandoff(clientId, seed) {
    if (!isGraphEnabled()) return null;
    const res = await graphQuery(
        clientId,
        `MATCH (h:Handoff {id: $id}) SET h.status = 'done', h.completed_ts = $ts`,
        { id: graphIds.handoff(seed), ts: Date.now() },
    );
    return res.ok || null;
}

/** A Read that answers (or moves) an open Agenda question. */
export async function graphWriteRead(clientId, {
    readId, questionId = null, headline, evidence = [], confidence = null, entityName = null, entityId = null,
}) {
    const id = await mergeNode(clientId, 'Read', graphIds.read(readId), {
        headline, confidence, created_ts: Date.now(), ts: Date.now(),
    });
    if (!id) return null;
    if (questionId) {
        await mergeNode(clientId, 'Question', graphIds.question(questionId), { status: 'open' });
        await mergeEdge(clientId, id, 'ANSWERS', graphIds.question(questionId));
    }
    if (entityName || entityId) {
        const ent = await graphWriteEntity(clientId, { entityId, name: entityName });
        if (ent) await mergeEdge(clientId, id, 'ABOUT', ent);
    }
    for (const ev of (evidence || []).slice(0, 5)) {
        const evUrl = ev?.url;
        if (!evUrl) continue;
        const evId = graphIds.evidence(`${readId}:${evUrl}`.slice(0, 200));
        await mergeNode(clientId, 'Evidence', evId, { url: evUrl, ts: Date.now(), provenance: 'read' });
        await mergeEdge(clientId, evId, 'ABOUT', id);
    }
    return id;
}

/** An Agenda question enters the graph the day it is opened. */
export async function graphWriteQuestion(clientId, { questionId, question, watchFor = null, status = 'open' }) {
    return mergeNode(clientId, 'Question', graphIds.question(questionId), {
        question, watch_for: watchFor, status, ts: Date.now(),
    });
}

/**
 * The Ask-Bahirjee write-back: a confident Stage-2 answer becomes Evidence +
 * Finding about the tenant's company node, so the next identical question in a
 * NEW session resolves through `recall` instead of another paid web search.
 */
export async function graphWriteQaFinding(clientId, { question, answer, sourceUrl }) {
    await graphWriteCompany(clientId, {});
    const coId = graphIds.company(clientId);
    const seed = randomUUID();

    const evId = sourceUrl ? graphIds.evidence(`qa:${seed}`) : null;
    if (evId) {
        await mergeNode(clientId, 'Evidence', evId, {
            url: sourceUrl, ts: Date.now(), provenance: 'ask_bahirjee',
        });
        await mergeEdge(clientId, evId, 'ABOUT', coId);
    }
    const fId = await mergeNode(clientId, 'Finding', graphIds.finding(`qa:${seed}`), {
        headline: `Q&A: ${String(question || '').slice(0, 120)}`,
        body: String(answer || '').slice(0, 2000),
        observed_at: Date.now(),
        ts: Date.now(),
        provenance: 'ask_bahirjee',
    });
    if (fId) await mergeEdge(clientId, fId, 'ABOUT', coId);

    // Entity anchoring: a finding ABOUT only the company is invisible to
    // recall(entity). Probe the question's capitalised tokens and link the
    // finding (and its evidence) to any entity they resolve to — that's what
    // makes "Does ShipSwift offer discounts?" re-answer from memory.
    if (fId) {
        const entities = await probeQuestionEntities(clientId, question, { max: 2 });
        for (const ent of entities) {
            if (ent.id === coId) continue;
            await mergeEdge(clientId, fId, 'ABOUT', ent.id);
            if (evId) await mergeEdge(clientId, evId, 'ABOUT', ent.id);
        }
    }
    return fId;
}
