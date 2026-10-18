/**
 * Track 2 graph round-trip: outcome matrix against a fake FalkorDB client.
 *
 * Same discipline as _fakePostgrest.mjs — pin WHAT THE GRAPH SAW (queries
 * issued, params sent, which tenant graph was selected), not just what the
 * code returned. The failure mode this file exists for: nothing throws and
 * the memory layer is quietly wrong — an unknown entity that still runs a
 * query, a tenant B answer served from tenant A's graph, a model-invented
 * path presented as memory.
 *
 * The fake is script-driven: entries { re, rows | rows(params, cypher) } are
 * matched against the Cypher text, in order. Unmatched queries answer [].
 *
 * Run: node scripts/graph-roundtrip.test.mjs
 */

process.env.MEMORY_GRAPH_ENABLED = '1';
process.env.FALKORDB_URL = 'falkor://fake.invalid:6379';
process.env.MEMORY_GRAPH_MAX_STEPS = '4';

import assert from 'node:assert/strict';
import { __setGraphClientForTests, graphNameFor, isGraphEnabled } from '../lib/_graph.js';
import { runGraphTool } from '../lib/_graphTools.js';
import { askGraph, answerIsGrounded } from '../lib/_graphAgent.js';
import { graphWriteQaFinding } from '../lib/_graphWriter.js';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';
const AWS_ROW = { e: { id: 'e-aws', name: 'AWS', ts: 1 } };
const FRESHFARE_ROW = { e: { id: 'e-ff', name: 'FreshFare', ts: 1 } };
const K8S_ROW = { e: { id: 'e-k8s', name: 'Kubernetes', ts: 1 } };

let passed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

// ── Fake FalkorDB client ─────────────────────────────────────────────────────

function makeFakeClient(script = []) {
    const calls = [];
    const graphs = new Map();
    const run = (kind, graph, cypher, opts) => {
        calls.push({ kind, graph, cypher, params: opts?.params });
        const hit = script.find((e) => e.re.test(cypher));
        const rows = !hit ? [] : (typeof hit.rows === 'function' ? hit.rows(opts?.params, cypher) : hit.rows) ?? [];
        return { data: rows };
    };
    return {
        calls,
        selectGraph(name) {
            graphs.set(name, true);
            return {
                query: (c, o) => Promise.resolve(run('query', name, c, o)),
                roQuery: (c, o) => Promise.resolve(run('roQuery', name, c, o)),
            };
        },
        list: () => Promise.resolve([...graphs.keys()]),
        close: () => Promise.resolve(),
    };
}

// Matchers for the human-authored Cypher in _graphTools.js / _graphWriter.js
const RE = {
    resolve: /e\.name_key = \$key/,
    recall: /\(x\)-\[:ABOUT\|SUPPORTED_BY\|CONTRADICTED_BY\|TESTS\|ANSWERS\*1\.\.2\]-\(e\)/,
    blast: /\(e\)-\[:DEPENDS_ON\|PARTNERS_WITH\|COMPETES_WITH\|MONITORS\|REGULATED_BY\*1\.\.\d+\]-\(x\)/,
    nextAgent: /h:Handoff \{status: 'pending'\}/,
    recentChanges: /n:Finding OR n:Evidence OR n:Read/,
    spPaths: /algo\.SPpaths/,
    pageRank: /algo\.pageRank/,
    mergeFinding: /MERGE \(n:Finding \{id: \$id\}\)/,
    aboutEdge: /MERGE \(a\)-\[r:ABOUT\]->\(b\)/,
};

/** Resolve exactly the entities the test names; everything else is unknown. */
const resolverFor = (rowsByKey) => ({
    re: RE.resolve,
    rows: (params) => rowsByKey[params.key] || [],
});

// ── Tenant names + disabled path ─────────────────────────────────────────────

await check('tenant graph names are per-client and validated', () => {
    assert.equal(graphNameFor(CLIENT_A), `bahirjee:${CLIENT_A}`);
    assert.notEqual(graphNameFor(CLIENT_A), graphNameFor(CLIENT_B));
    assert.throws(() => graphNameFor('not-a-uuid'));
    assert.throws(() => graphNameFor('bahirjee:evil'));
});

await check('disabled env returns graph_unavailable without any query', async () => {
    const fake = makeFakeClient([]);
    __setGraphClientForTests(fake);
    const was = process.env.MEMORY_GRAPH_ENABLED;
    process.env.MEMORY_GRAPH_ENABLED = '0';
    const r = await runGraphTool(CLIENT_A, 'recall', { entity: 'AWS' });
    process.env.MEMORY_GRAPH_ENABLED = was;
    assert.equal(r.outcome, 'graph_unavailable');
    assert.equal(fake.calls.length, 0, 'no query reached the graph while disabled');
});

// ── Outcome matrix ───────────────────────────────────────────────────────────

{
    const fake = makeFakeClient([resolverFor({})]);
    __setGraphClientForTests(fake);

    await check('unknown_entity returns before the tool query runs', async () => {
        const r = await runGraphTool(CLIENT_A, 'recall', { entity: 'Zorblax Industries' });
        assert.equal(r.outcome, 'unknown_entity');
        const reads = fake.calls.filter((c) => c.kind === 'roQuery');
        assert.equal(reads.length, 1, 'only the resolution lookup may run');
        assert.match(reads[0].cypher, RE.resolve);
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW] }),
        {
            re: RE.recall,
            rows: [
                { x: { labels: ['Finding'], properties: { id: 'f-1', name: 'AWS incident windows lengthening', ts: 100 } }, p: [{ name: 'f-1' }, { name: 'AWS' }] },
                { x: { labels: ['Read'], properties: { id: 'r-1', name: 'Read: AWS incident history', ts: 90 } }, p: [{ name: 'r-1' }, { name: 'AWS' }] },
            ],
        },
    ]);
    __setGraphClientForTests(fake);

    await check('recall returns stored memory for a known entity', async () => {
        const r = await runGraphTool(CLIENT_A, 'recall', { entity: 'aws' });
        assert.equal(r.outcome, 'answered_from_memory');
        assert.equal(r.entity, 'AWS');
        assert.equal(r.nodes.length, 2);
        assert.equal(r.nodes[0].label, 'Finding');
        assert.equal(r.memory_ts, 100);
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW] }),
        {
            re: RE.blast,
            rows: (params, cypher) =>
                cypher.includes('*1..1]')
                    ? [{ p: [{ name: 'AWS' }, { name: 'Kubernetes' }] }]
                    : [
                          { p: [{ name: 'AWS' }, { name: 'Kubernetes' }, { name: 'Acme Freight' }, { name: 'FreshFare' }] },
                          { p: [{ name: 'AWS' }, { name: 'Zenith Analytics' }] },
                      ],
        },
    ]);
    __setGraphClientForTests(fake);

    await check('blast_radius depth 1 and depth 4 genuinely differ', async () => {
        const shallow = await runGraphTool(CLIENT_A, 'blast_radius', { entity: 'AWS', depth: 1 });
        const deep = await runGraphTool(CLIENT_A, 'blast_radius', { entity: 'AWS', depth: 4 });
        assert.equal(shallow.outcome, 'answered_with_path');
        assert.equal(shallow.paths.length, 1);
        assert.ok(deep.paths.length > shallow.paths.length);
        assert.ok(deep.paths.some((p) => p.length === 4), 'deep path actually traverses four hops');
        // Depth travels spliced into the Cypher string — pin what was sent.
        const depths = fake.calls.filter((c) => RE.blast.test(c.cypher)).map((c) => c.cypher.match(/\*1\.\.(\d+)\]/)[1]);
        assert.deepEqual(depths, ['1', '4']);
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ freshfare: [FRESHFARE_ROW], aws: [AWS_ROW] }),
        { re: RE.spPaths, rows: [{ path: [{ name: 'FreshFare' }, { name: 'Acme Freight' }, { name: 'Kubernetes' }, { name: 'AWS' }] }] },
    ]);
    __setGraphClientForTests(fake);

    await check('path_between returns the actual SPpaths route', async () => {
        const r = await runGraphTool(CLIENT_A, 'path_between', { from_entity: 'FreshFare', to_entity: 'AWS' });
        assert.equal(r.outcome, 'answered_with_path');
        assert.equal(r.paths[0].join(' → '), 'FreshFare → Acme Freight → Kubernetes → AWS');
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW], spotfleet: [{ e: { id: 'e-spot', name: 'SpotFleet' } }] }),
        { re: RE.spPaths, rows: [] },
    ]);
    __setGraphClientForTests(fake);

    await check('known-but-disconnected entities return not_in_graph', async () => {
        const r = await runGraphTool(CLIENT_A, 'path_between', { from_entity: 'AWS', to_entity: 'SpotFleet' });
        assert.equal(r.outcome, 'not_in_graph');
        // not_in_graph is a coverage fact, not a claim of absence — and the
        // entity resolution DID run (both are known), only the path is missing.
        assert.equal(fake.calls.filter((c) => c.kind === 'roQuery').length, 3);
    });
}

{
    const fake = makeFakeClient([
        { re: RE.pageRank, rows: [{ node: { properties: { id: 'e-k8s', name: 'Kubernetes' } }, score: 0.41 }] },
    ]);
    __setGraphClientForTests(fake);

    await check('load_bearing returns pageRank-ranked entities', async () => {
        const r = await runGraphTool(CLIENT_A, 'load_bearing', { limit: 5 });
        assert.equal(r.outcome, 'answered_with_path');
        assert.equal(r.ranked[0].name, 'Kubernetes');
        assert.equal(r.ranked[0].score, 0.41);
    });
}

// ── Write path + tenant isolation ────────────────────────────────────────────

{
    const fake = makeFakeClient([]);
    __setGraphClientForTests(fake);

    await check('Q&A finding write lands as Finding+ABOUT on the right tenant graph', async () => {
        const id = await graphWriteQaFinding(CLIENT_A, { question: 'is aws stable', answer: 'mostly', sourceUrl: 'https://x' });
        assert.ok(id.startsWith('fnd:qa:'));
        const writes = fake.calls.filter((c) => c.kind === 'query');
        assert.ok(writes.some((c) => RE.mergeFinding.test(c.cypher)), 'Finding merge issued');
        assert.ok(writes.some((c) => RE.aboutEdge.test(c.cypher)), 'ABOUT edge issued');
        assert.ok(writes.every((c) => c.graph === `bahirjee:${CLIENT_A}`), 'all writes on tenant A graph');
        assert.ok(fake.calls.every((c) => c.graph !== `bahirjee:${CLIENT_B}`), 'tenant B graph never touched');
    });
}

// ── Agent loop ───────────────────────────────────────────────────────────────

{
    const fake = makeFakeClient([
        resolverFor({ freshfare: [FRESHFARE_ROW], aws: [AWS_ROW] }),
        { re: RE.spPaths, rows: [{ path: [{ name: 'FreshFare' }, { name: 'Acme Freight' }, { name: 'Kubernetes' }, { name: 'AWS' }] }] },
    ]);
    __setGraphClientForTests(fake);

    await check('ask loop: tool step then grounded answer → answered_with_path', async () => {
        const r = await askGraph(CLIENT_A, 'how does FreshFare depend on AWS?', {
            stepFn: async ({ step, stepsUsed }) =>
                stepsUsed === 0
                    ? { done: false, tool: 'path_between', args: { from_entity: 'FreshFare', to_entity: 'AWS' } }
                    : { done: true, answer: 'FreshFare depends on AWS via Acme Freight and Kubernetes.' },
        });
        assert.equal(r.outcome, 'answered_with_path');
        assert.equal(r.steps, 1, 'one tool call, then done');
        assert.equal(r.tool_trace[0].tool, 'path_between');
        assert.ok(r.paths[0].includes('Acme Freight'));
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW], kubernetes: [K8S_ROW] }),
        { re: RE.spPaths, rows: [{ path: [{ name: 'AWS' }, { name: 'Kubernetes' }] }] },
    ]);
    __setGraphClientForTests(fake);

    await check('a model-invented entity is rejected, never presented as memory', async () => {
        const r = await askGraph(CLIENT_A, 'what does AWS depend on?', {
            stepFn: async ({ stepsUsed }) =>
                stepsUsed === 0
                    ? { done: false, tool: 'path_between', args: { from_entity: 'AWS', to_entity: 'Kubernetes' } }
                    : // The graph returned AWS→Kubernetes; the answer invents Zorblax.
                      { done: true, answer: 'AWS depends on Zorblax Heavy Industries.' },
        });
        assert.match(r.note || '', /rejected/);
        assert.ok(!r.answer.includes('Zorblax'), 'fabricated name never reaches the founder');
        assert.ok(r.answer.includes('AWS → Kubernetes'), 'the real path is reported instead');
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW] }),
        { re: RE.recall, rows: [{ x: { labels: ['Finding'], properties: { id: 'f-1', name: 'x', ts: 1 } }, p: [] }] },
    ]);
    __setGraphClientForTests(fake);

    await check('step cap is enforced — no fifth move even with good results', async () => {
        const r = await askGraph(CLIENT_A, 'AWS?', {
            stepFn: async () => ({ done: false, tool: 'recall', args: { entity: 'AWS' } }),
        });
        assert.equal(r.steps, 4);
        assert.equal(r.tool_trace.length, 4);
    });
}

{
    const fake = makeFakeClient([resolverFor({})]);
    __setGraphClientForTests(fake);

    await check('unknown_entity is terminal — the loop exits at the first step', async () => {
        const r = await askGraph(CLIENT_A, 'when will Zorblax matter?', {
            stepFn: async () => ({ done: false, tool: 'recall', args: { entity: 'Zorblax' } }),
        });
        assert.equal(r.outcome, 'unknown_entity');
        assert.equal(r.steps, 1);
        assert.equal(r.tool_trace[0].outcome, 'unknown_entity');
    });
}

{
    const fake = makeFakeClient([
        resolverFor({ aws: [AWS_ROW] }),
        { re: RE.recall, rows: [{ x: { labels: ['Finding'], properties: { id: 'f-1', name: 'AWS finding', ts: 50 } }, p: [] }] },
    ]);
    __setGraphClientForTests(fake);

    await check('prior-work questions force recall first, before the model moves', async () => {
        const r = await askGraph(CLIENT_A, 'what did we learn last time about AWS?', {
            stepFn: async () => ({ done: true, answer: 'AWS finding was already stored.' }),
        });
        assert.equal(r.tool_trace[0].tool, 'recall');
        assert.equal(r.tool_trace[0].forced, true);
        assert.equal(r.outcome, 'answered_from_memory');
    });
}

await check('answerIsGrounded vocabulary check', () => {
    assert.equal(answerIsGrounded('AWS connects to Kubernetes', new Set(['aws', 'kubernetes'])), true);
    assert.equal(answerIsGrounded('AWS connects to Zorblax', new Set(['aws'])), false);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
