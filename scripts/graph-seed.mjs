/**
 * Seed a synthetic tenant graph for the Track 2 demo.
 *
 *   node --env-file=.env scripts/graph-seed.mjs [--client <uuid>]
 *
 * Hackathon rules permit synthetic data; this tenant ("Acme Freight") exists so
 * the fixed tools have real structure to traverse. Real tenants get their
 * graph from the live writers in lib/_graphWriter.js — this script is a demo
 * fixture, not the production data path.
 *
 * The seeded topology is deliberate:
 *   - a DEPENDS_ON chain 4 edges deep (Acme→Kubernetes→AWS→Equinix→PowerGrid)
 *     so blast_radius depth 1 vs depth 4 visibly differ;
 *   - a competitor sharing the AWS dependency, so blast radius crosses a
 *     COMPETES_WITH boundary;
 *   - Zendesk: a known, monitored entity that is DISCONNECTED from the
 *     dependency graph — it exists to produce `not_in_graph`, not to error.
 *   - a pending Handoff(watcher→triage) so next_agent has state to return.
 */

import { graphPing, graphQuery, ensureSchema, graphNameFor, isGraphEnabled } from '../lib/_graph.js';

const argClient = process.argv.includes('--client')
    ? process.argv[process.argv.indexOf('--client') + 1]
    : null;
const CLIENT_ID = argClient || process.env.SEED_CLIENT_ID || '00000000-0000-4000-8000-00000000000d';

const NOW = Date.now();
const HOUR = 3600 * 1000;

// name_key is the entity-resolution key: lowercase, trimmed — the same
// normalisation signalEntityKey() uses for tracked_entities lookups.
const key = (name) => name.toLowerCase().trim();

const NODES = [
    { label: 'Company', id: `co:${CLIENT_ID}`, props: { name: 'Acme Freight', name_key: key('Acme Freight'), domain: 'acme-freight.example' } },

    { label: 'Agent', id: 'agt:watcher', props: { name: 'watcher', role: 'sense' } },
    { label: 'Agent', id: 'agt:triage', props: { name: 'triage', role: 'triage' } },
    { label: 'Agent', id: 'agt:pursuer', props: { name: 'pursuer', role: 'pursue' } },

    { label: 'Entity', id: 'ent:kubernetes', props: { name: 'Kubernetes', name_key: key('Kubernetes'), category: 'infra' } },
    { label: 'Entity', id: 'ent:aws', props: { name: 'AWS', name_key: key('AWS'), category: 'infra' } },
    { label: 'Entity', id: 'ent:equinix', props: { name: 'Equinix DC-14', name_key: key('Equinix DC-14'), category: 'infra' } },
    { label: 'Entity', id: 'ent:powergrid', props: { name: 'State PowerGrid', name_key: key('State PowerGrid'), category: 'regulator' } },
    { label: 'Entity', id: 'ent:stripe', props: { name: 'Stripe', name_key: key('Stripe'), category: 'platform' } },
    { label: 'Entity', id: 'ent:shipswift', props: { name: 'ShipSwift', name_key: key('ShipSwift'), category: 'competitor' } },
    { label: 'Entity', id: 'ent:fleetedge', props: { name: 'FleetEdge', name_key: key('FleetEdge'), category: 'competitor' } },
    { label: 'Entity', id: 'ent:delhivery', props: { name: 'Delhivery', name_key: key('Delhivery'), category: 'partner' } },
    { label: 'Entity', id: 'ent:dpiit', props: { name: 'DPIIT', name_key: key('DPIIT'), category: 'regulator' } },
    { label: 'Entity', id: 'ent:gmaps', props: { name: 'Google Maps Platform', name_key: key('Google Maps Platform'), category: 'platform' } },
    { label: 'Entity', id: 'ent:brokers', props: { name: 'Local Freight Brokers', name_key: key('Local Freight Brokers'), category: 'adjacent' } },
    // Disconnected on purpose: monitored, but no path into the dependency web.
    { label: 'Entity', id: 'ent:zendesk', props: { name: 'Zendesk', name_key: key('Zendesk'), category: 'platform' } },

    { label: 'Belief', id: 'belief:concentration', props: { statement: 'Acme Freight is exposed to infrastructure concentration risk.', confidence: 'medium' } },
    { label: 'Question', id: 'q:aws-spof', props: { question: 'Is the AWS dependency a single point of failure for Acme?', status: 'open', watch_for: 'AWS status events or multi-region redundancy announcements' } },
    { label: 'Finding', id: 'find:shipswift-pricing', props: { headline: 'ShipSwift published a new enterprise pricing tier', observed_at: NOW - 2 * HOUR } },
    { label: 'Evidence', id: 'ev:aws-status', props: { url: 'https://status.aws.amazon.com/', title: 'AWS Health Dashboard', excerpt: 'Synthetic demo evidence.' } },
    { label: 'Read', id: 'read:aws-read', props: { headline: 'AWS remains the critical single dependency', created_ts: NOW - 24 * HOUR } },
    { label: 'Session', id: 'sess:weekly-1', props: { kind: 'weekly_synthesis', started_ts: NOW - 24 * HOUR } },
    { label: 'Session', id: 'sess:daily-1', props: { kind: 'daily_ladder', started_ts: NOW - 2 * HOUR } },
    { label: 'Handoff', id: 'ho:watcher-triage-1', props: { status: 'pending', reason: 'material page change detected', created_ts: NOW - 1 * HOUR } },
];

const EDGES = [
    [`co:${CLIENT_ID}`, 'MONITORS', 'ent:kubernetes'], [`co:${CLIENT_ID}`, 'MONITORS', 'ent:aws'],
    [`co:${CLIENT_ID}`, 'MONITORS', 'ent:stripe'], [`co:${CLIENT_ID}`, 'MONITORS', 'ent:shipswift'],
    [`co:${CLIENT_ID}`, 'MONITORS', 'ent:fleetedge'], [`co:${CLIENT_ID}`, 'MONITORS', 'ent:delhivery'],
    [`co:${CLIENT_ID}`, 'MONITORS', 'ent:dpiit'], [`co:${CLIENT_ID}`, 'MONITORS', 'ent:gmaps'],
    [`co:${CLIENT_ID}`, 'MONITORS', 'ent:brokers'], [`co:${CLIENT_ID}`, 'MONITORS', 'ent:zendesk'],

    // The 4-edge dependency chain under the company node.
    [`co:${CLIENT_ID}`, 'DEPENDS_ON', 'ent:kubernetes'],
    ['ent:kubernetes', 'DEPENDS_ON', 'ent:aws'],
    ['ent:aws', 'DEPENDS_ON', 'ent:equinix'],
    ['ent:equinix', 'DEPENDS_ON', 'ent:powergrid'],
    [`co:${CLIENT_ID}`, 'DEPENDS_ON', 'ent:stripe'],
    [`co:${CLIENT_ID}`, 'DEPENDS_ON', 'ent:gmaps'],

    ['ent:shipswift', 'COMPETES_WITH', `co:${CLIENT_ID}`],
    ['ent:fleetedge', 'COMPETES_WITH', `co:${CLIENT_ID}`],
    // Shared dependency: an AWS event lands in both companies' blast radius.
    ['ent:shipswift', 'DEPENDS_ON', 'ent:aws'],
    [`co:${CLIENT_ID}`, 'PARTNERS_WITH', 'ent:delhivery'],
    [`co:${CLIENT_ID}`, 'REGULATED_BY', 'ent:dpiit'],

    ['ev:aws-status', 'ABOUT', 'ent:aws'],
    ['belief:concentration', 'ABOUT', 'ent:aws'],
    ['belief:concentration', 'SUPPORTED_BY', 'ev:aws-status'],
    ['q:aws-spof', 'TESTS', 'belief:concentration'],
    ['find:shipswift-pricing', 'ABOUT', 'ent:shipswift'],
    ['read:aws-read', 'ANSWERS', 'q:aws-spof'],
    ['read:aws-read', 'ABOUT', 'ent:aws'],

    ['sess:weekly-1', 'BY', 'agt:pursuer'],
    ['sess:daily-1', 'BY', 'agt:watcher'],
    ['ho:watcher-triage-1', 'CONCERNS', 'find:shipswift-pricing'],
    ['ho:watcher-triage-1', 'FROM', 'agt:watcher'],
    ['ho:watcher-triage-1', 'TO', 'agt:triage'],
];

async function main() {
    if (!isGraphEnabled()) {
        console.error('MEMORY_GRAPH_ENABLED is not 1 — seeding refused. Set it in .env first.');
        process.exit(1);
    }

    console.log(`Graph: ${graphNameFor(CLIENT_ID)}`);
    const ping = await graphPing();
    if (!ping.ok) {
        console.error('FalkorDB unreachable:', ping.error);
        process.exit(1);
    }
    console.log('Connected. Existing graphs:', JSON.stringify(ping.data.graphs));

    console.log('Ensuring schema…');
    const schema = await ensureSchema(CLIENT_ID);
    if (!schema.ok) { console.error('Schema failed:', schema.error); process.exit(1); }

    const base = { tenant: CLIENT_ID, ts: NOW, provenance: 'graph-seed.mjs (synthetic)' };

    for (const node of NODES) {
        const res = await graphQuery(
            CLIENT_ID,
            `MERGE (n:${node.label} {id: $id}) SET n += $props`,
            { id: node.id, props: { ...base, ...node.props } },
        );
        if (!res.ok) { console.error(`Node ${node.id} failed:`, res.error); process.exit(1); }
    }
    console.log(`Seeded ${NODES.length} nodes.`);

    for (const [a, rel, b] of EDGES) {
        const res = await graphQuery(
            CLIENT_ID,
            `MATCH (a {id: $a}), (b {id: $b}) MERGE (a)-[r:${rel}]->(b)`,
            { a, b },
        );
        if (!res.ok) { console.error(`Edge ${a}-[${rel}]->${b} failed:`, res.error); process.exit(1); }
    }
    console.log(`Seeded ${EDGES.length} edges.`);

    const counts = await graphQuery(
        CLIENT_ID,
        'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY label',
    );
    console.log('\nLabel counts:');
    for (const row of counts.data || []) console.log(`  ${row.label}: ${row.n}`);
    console.log('\nDone. Inspect in FalkorDB Browser, or run a tool check next.');
}

main().catch((e) => { console.error(e); process.exit(1); });
