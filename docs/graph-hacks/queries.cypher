// ─────────────────────────────────────────────────────────────────────────────
// Bahirjee memory graph: every Cypher query and graph algorithm the product runs
// ─────────────────────────────────────────────────────────────────────────────
//
// These are the exact queries from the code, with their $parameters filled in
// with values from the synthetic seed tenant (scripts/graph-seed.mjs), so each
// one can be pasted into FalkorDB Browser as is.
//
// How to use:
//   1. node --env-file=.env scripts/graph-seed.mjs
//   2. Open FalkorDB Browser (http://localhost:3000 for Docker) and select graph
//        bahirjee:00000000-0000-4000-8000-00000000000d
//   3. Run ONE statement at a time (the Browser runs a single query per request).
//
// Seed ids used below:
//   company   co:00000000-0000-4000-8000-00000000000d   (Acme Freight)
//   entities  ent:aws, ent:kubernetes, ent:equinix, ent:powergrid, ent:shipswift,
//             ent:fleetedge, ent:stripe, ent:delhivery, ent:dpiit, ent:gmaps,
//             ent:brokers, ent:zendesk (monitored, but has no memory about it)
//   agents    agt:watcher, agt:triage, agt:pursuer
//
// In the code, the model never writes or edits any of this. It picks one of
// six tools; the tool runs its fixed query with typed, validated parameters.
// Source: lib/_graphTools.js (reads), lib/_graphWriter.js (writes),
//         lib/_graph.js (schema), lib/handlers/graph.js (activity feed).


// ═════════════════════════════════════════════════════════════════════════════
// 0. LOOK AT THE GRAPH
// ═════════════════════════════════════════════════════════════════════════════

// Whole tenant graph, for the Browser's visual view.
MATCH (n)-[r]->(m) RETURN n, r, m;

// Node counts by label (the same query the seed script prints at the end).
MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY label;


// ═════════════════════════════════════════════════════════════════════════════
// 1. THE ENTITY GATE: runs before every tool
// ═════════════════════════════════════════════════════════════════════════════
// Resolves a name to a node by its lowercased name_key. If this returns
// nothing, the tool stops with outcome `unknown_entity` and no other query runs.
// $key = 'aws'

MATCH (e) WHERE (e:Entity OR e:Company) AND e.name_key = 'aws' RETURN e LIMIT 2;

// A name the graph has never seen: returns no rows → unknown_entity.
MATCH (e) WHERE (e:Entity OR e:Company) AND e.name_key = 'zorblax' RETURN e LIMIT 2;


// ═════════════════════════════════════════════════════════════════════════════
// 2. recall(entity): what do we already know about it?
// ═════════════════════════════════════════════════════════════════════════════
// Findings, reads, beliefs, evidence and questions within 2 hops over the
// memory relationships. Outcome: answered_from_memory.
// $id = 'ent:aws', $limit = 50

MATCH (e {id: 'ent:aws'})
MATCH p = (x)-[:ABOUT|SUPPORTED_BY|CONTRADICTED_BY|TESTS|ANSWERS*1..2]-(e)
WHERE x:Finding OR x:Read OR x:Belief OR x:Evidence OR x:Question
RETURN x, p LIMIT 50;

// Known entity with no memory attached: returns no rows → not_in_graph
// (a fact about what the graph covers, never a claim that nothing exists).
MATCH (e {id: 'ent:zendesk'})
MATCH p = (x)-[:ABOUT|SUPPORTED_BY|CONTRADICTED_BY|TESTS|ANSWERS*1..2]-(e)
WHERE x:Finding OR x:Read OR x:Belief OR x:Evidence OR x:Question
RETURN x, p LIMIT 50;


// ═════════════════════════════════════════════════════════════════════════════
// 3. blast_radius(entity, depth): what is exposed if it fails?
// ═════════════════════════════════════════════════════════════════════════════
// Variable-length traversal over the dependency relationships, returning
// complete paths. Depth is the one value spliced into the query string (Cypher
// cannot parameterise a variable-length bound); the code checks it is an
// integer from 1 to 4 first. Outcome: answered_with_path.
// $id = 'ent:aws', $limit = 50

// depth 1: only direct neighbours
MATCH (e {id: 'ent:aws'})
MATCH p = (e)-[:DEPENDS_ON|PARTNERS_WITH|COMPETES_WITH|MONITORS|REGULATED_BY*1..1]-(x)
RETURN p LIMIT 50;

// depth 4: the full chain (Acme Freight → Kubernetes → AWS → Equinix → State
// PowerGrid), plus ShipSwift, a competitor that shares the AWS dependency
MATCH (e {id: 'ent:aws'})
MATCH p = (e)-[:DEPENDS_ON|PARTNERS_WITH|COMPETES_WITH|MONITORS|REGULATED_BY*1..4]-(x)
RETURN p LIMIT 50;


// ═════════════════════════════════════════════════════════════════════════════
// 4. path_between(a, b): how are two entities connected?
// ═════════════════════════════════════════════════════════════════════════════
// FalkorDB's shortest-paths algorithm (algo.SPpaths), up to 3 paths of at most
// 6 hops, ignoring direction. Outcome: answered_with_path.
// $a = company id, $b = 'ent:powergrid', $limit = 25

MATCH (s {id: 'co:00000000-0000-4000-8000-00000000000d'}), (t {id: 'ent:powergrid'})
CALL algo.SPpaths({sourceNode: s, targetNode: t,
                   relTypes: ['DEPENDS_ON', 'PARTNERS_WITH', 'COMPETES_WITH', 'MONITORS', 'REGULATED_BY'],
                   undirected: true, pathCount: 3, maxLen: 6})
YIELD path RETURN path LIMIT 25;


// ═════════════════════════════════════════════════════════════════════════════
// 5. load_bearing(limit): which entities is everything resting on?
// ═════════════════════════════════════════════════════════════════════════════
// PageRank over the whole tenant graph, keeping Entity nodes only.
// $limit = 10

CALL algo.pageRank(NULL, NULL) YIELD node, score
WITH node, score WHERE node:Entity
RETURN node, score ORDER BY score DESC LIMIT 10;


// ═════════════════════════════════════════════════════════════════════════════
// 6. next_agent(entity): who owns the pending work on it?
// ═════════════════════════════════════════════════════════════════════════════
// Coordination state: pending Handoffs that concern work about the entity, and
// the agent each one is FROM and TO. The seed has one: watcher → triage,
// concerning the ShipSwift pricing finding.
// $id = 'ent:shipswift'

MATCH (e {id: 'ent:shipswift'})<-[:ABOUT]-(work)<-[:CONCERNS]-(h:Handoff {status: 'pending'})
MATCH (h)-[:FROM]->(fromAgt:Agent), (h)-[:TO]->(toAgt:Agent)
RETURN h, work, fromAgt, toAgt LIMIT 3;


// ═════════════════════════════════════════════════════════════════════════════
// 7. recent_changes(entity, since): what moved lately?
// ═════════════════════════════════════════════════════════════════════════════
// Findings, Evidence and Reads about the entity newer than `since` (epoch ms).
// The code defaults `since` to one week ago; timestamp() stands in for it here.
// $id = 'ent:aws', $since = now - 7 days, $limit = 50

MATCH (e {id: 'ent:aws'})<-[:ABOUT]-(n)
WHERE (n:Finding OR n:Evidence OR n:Read)
  AND coalesce(n.ts, n.observed_at, n.created_ts, 0) >= timestamp() - 7 * 86400000
RETURN n LIMIT 50;


// ═════════════════════════════════════════════════════════════════════════════
// 8. Activity feed: POST /api/graph { action: 'activity' }
// ═════════════════════════════════════════════════════════════════════════════
// The Memory & Coordination feed: the latest Handoffs, Findings, Reads and
// Sessions the agents wrote, newest first. $limit = 25

MATCH (n)
WHERE n:Handoff OR n:Finding OR n:Read OR n:Session
RETURN n ORDER BY coalesce(n.ts, n.created_ts, n.started_ts, n.observed_at, 0) DESC
LIMIT 25;


// ═════════════════════════════════════════════════════════════════════════════
// 9. WRITES: what the agents run when they learn something
// ═════════════════════════════════════════════════════════════════════════════
// Every write is an idempotent MERGE. In the code the label and relationship
// type come from fixed whitelists (Cypher cannot parameterise them), and every
// value is a $parameter. Running these adds a demo finding and handoff to the
// seed graph; re-seed to reset it.

// mergeNode: a Finding the watcher records about a changed page
MERGE (n:Finding {id: 'fnd:demo-judge'})
SET n += {tenant: '00000000-0000-4000-8000-00000000000d',
          headline: 'Demo: AWS status page changed', ts: timestamp()};

// mergeEdge: anchor it to the entity it is about
MATCH (a {id: 'fnd:demo-judge'}), (b {id: 'ent:aws'})
MERGE (a)-[r:ABOUT]->(b) SET r += {};

// A watcher → triage Handoff concerning that finding (mergeNode + three mergeEdges)
MERGE (n:Handoff {id: 'ho:demo-judge'})
SET n += {tenant: '00000000-0000-4000-8000-00000000000d',
          status: 'pending', reason: 'demo page change', created_ts: timestamp(), ts: timestamp()};
MATCH (a {id: 'ho:demo-judge'}), (b {id: 'agt:watcher'}) MERGE (a)-[r:FROM]->(b) SET r += {};
MATCH (a {id: 'ho:demo-judge'}), (b {id: 'agt:triage'}) MERGE (a)-[r:TO]->(b) SET r += {};
MATCH (a {id: 'ho:demo-judge'}), (b {id: 'fnd:demo-judge'}) MERGE (a)-[r:CONCERNS]->(b) SET r += {};

// Now next_agent sees it: rerun section 6 with ent:aws
MATCH (e {id: 'ent:aws'})<-[:ABOUT]-(work)<-[:CONCERNS]-(h:Handoff {status: 'pending'})
MATCH (h)-[:FROM]->(fromAgt:Agent), (h)-[:TO]->(toAgt:Agent)
RETURN h, work, fromAgt, toAgt LIMIT 3;

// graphCompleteHandoff: the receiving agent marks the handoff done
MATCH (h:Handoff {id: 'ho:demo-judge'}) SET h.status = 'done', h.completed_ts = timestamp();


// ═════════════════════════════════════════════════════════════════════════════
// 10. SCHEMA BOOTSTRAP: ensureSchema() in lib/_graph.js
// ═════════════════════════════════════════════════════════════════════════════
// Run once per tenant graph. An index that already exists makes the statement
// fail with an "already indexed" error, which the code treats as success.

// Lookup index on `id` for each of the ten labels
CREATE INDEX FOR (n:Company) ON (n.id);
CREATE INDEX FOR (n:Entity) ON (n.id);
CREATE INDEX FOR (n:Evidence) ON (n.id);
CREATE INDEX FOR (n:Belief) ON (n.id);
CREATE INDEX FOR (n:Question) ON (n.id);
CREATE INDEX FOR (n:Finding) ON (n.id);
CREATE INDEX FOR (n:Read) ON (n.id);
CREATE INDEX FOR (n:Agent) ON (n.id);
CREATE INDEX FOR (n:Session) ON (n.id);
CREATE INDEX FOR (n:Handoff) ON (n.id);

// Backs the entity gate (section 1), which runs before every tool
CREATE INDEX FOR (e:Entity) ON (e.name_key);

// Unique `id` per label. This is a FalkorDB module command, not Cypher, so it
// does not run in the Browser's query box. The code issues it through the
// client (graph.constraintCreate('UNIQUE', 'NODE', label, 'id')); from
// redis-cli it is, for each label:
//   GRAPH.CONSTRAINT CREATE bahirjee:00000000-0000-4000-8000-00000000000d UNIQUE NODE Entity PROPERTIES 1 id
