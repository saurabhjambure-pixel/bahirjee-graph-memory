---
agent: devin-local
session: falkordb-memory-graph
created: 2026-10-17
branch: falkordb-memory-graph
---
# Track 2 — FalkorDB Memory & Coordination Agent

Add a graph-native memory and coordination layer (FalkorDB) for the Graph Hacks
hackathon. FalkorDB does essential product work — cross-session memory, agent
handoffs, multi-hop path reasoning — proven by showing that removing it degrades
those behaviours visibly. Supabase remains the system of record for auth,
reports, and all existing product data; the graph is authoritative for Track 2
reads but **rebuildable from Supabase** (derived-projection posture, so a failed
graph can never split-brain the product).

## Scope decisions (locked)

- One FalkorDB graph per tenant: `bahirjee:{client_id}`, name derived server-side
  only — never from a request body.
- Demo tenant is seeded with **synthetic** data (rules permit). Real backfill
  from v31/v34 tables is deferred.
- `Belief` = `strategic_assumptions` + `brief.what_could_change_our_view` items.
  No bespoke belief machinery.
- Entity↔Entity edges (`DEPENDS_ON`/`COMPETES_WITH`/`PARTNERS_WITH`) are seeded
  for the demo — `entity_relationships.from_entity_id` is always NULL today, so
  real inter-entity edges don't exist yet. Disclosed in the README.
- Watcher / triage / pursuer = the existing daily-ladder rungs in
  `lib/handlers/cron-daily.js`, modelled as `Agent` nodes. Handoffs are written
  on rung transitions.
- The LLM never generates Cypher. It picks one of six fixed tools with typed
  args; every query is human-authored, parameterized, and capped.
- Degraded mode is built FIRST: `MEMORY_GRAPH_ENABLED=0` → writes no-op, reads
  return `graph_unavailable`, UI labels answers "degraded". This is the
  judge-facing removal test.

## Where the nodes already live (mapping)

| Graph node | Existing source |
|---|---|
| Company | `clients` / `company_contexts` (v26) |
| Entity | `tracked_entities` + canonical_domain/aliases (v31) |
| Entity↔Entity | `entity_relationships` (v31 — self-anchored only today) |
| Evidence | `observations` |
| Question | `open_questions` (v34 Agenda) |
| Read | `reads` (v34) |
| Finding | `structured_signals` / `reads` / watcher observations |
| Belief | `strategic_assumptions`, `what_could_change_our_view`, `brief_cards` |
| Agent | agent registry + daily-ladder rungs |
| Session | `intelligence_jobs` / `agent_runs` (v16) |
| Handoff | `agent_handoffs` (v16) + new cross-session ladder handoffs |

Reused conventions: `applyApiSecurity` on every handler; `requireAuthenticatedUser`
for tenant identity; fail-open writes that log loudly (same as `agentRunStore.js`);
`scripts/*.test.mjs` with a fake backing store (same style as `_fakePostgrest.mjs`);
schema-constrained JSON for every model call.

---

## Task 0 — FalkorDB foundation

**Goal:** a running graph you can query, plus the server-side client.

**Steps:**
- [x] ~~`docker run -p 6379:6379 -it --rm falkordb/falkordb`~~ (Docker not on
      this machine → FalkorDB Cloud free tier instead; `falkor://`, no TLS). Original note: FalkorDB serves the
      Redis protocol on 6379). FalkorDB Browser: `docker run -p 3000:3000 -it
      --rm falkordb/falkordb-browser` → http://localhost:3000.
- [x] `npm install falkordb`
- [x] Env vars in `.env.example` and `.env`:
      `FALKORDB_URL` (default `redis://localhost:6379`),
      `FALKORDB_USERNAME`, `FALKORDB_PASSWORD` (cloud/TLS only),
      `MEMORY_GRAPH_ENABLED` (`1` on for demo), `MEMORY_GRAPH_MAX_STEPS` (4).
- [x] Create `lib/_graph.js` (server-only):
  - `getGraphClient()` — connect with a hard timeout; on failure return
    `{ ok: false, outcome: 'graph_unavailable' }`, never throw.
  - `graphNameFor(clientId)` → `bahirjee:${clientId}` after UUID validation.
  - `graphQuery(graph, cypher, params)` / `graphRoQuery(...)` — $param
    placeholders only; the API exposes no raw-query surface.
  - `ensureSchema(graph)` — `CREATE INDEX` / unique constraints on `id`
    for each label.

**Verify:** connect from a REPL/script, run `GRAPH.QUERY`, see the graph in
FalkorDB Browser; wrong port → `graph_unavailable`, no throw.

---

## Task 1 — Seed the demo graph

**Goal:** a populated tenant graph so tools have something to traverse.

**Files to create:** `scripts/graph-seed.mjs`

**What it creates** (all nodes carry `id`, `tenant`, `source_id`, `ts`,
`provenance`):
- 1 `Company` (synthetic, e.g. "Acme Logistics")
- 3 `Agent` nodes: `watcher`, `triage`, `pursuer`
- ~12 `Entity` nodes across categories mirroring `tracked_entities`
  (infra / platform / competitor / regulator / industry_body / adjacent)
- Real chains so `blast_radius` differs at depth 1 vs depth 4:
  `Company-[:MONITORS]->Entity`, `Entity-[:DEPENDS_ON]->Entity`,
  `Entity-[:COMPETES_WITH]->Entity`, `Entity-[:PARTNERS_WITH]->Entity`
- A few `Evidence`, `Question`, `Finding`, `Read`, `Session`, `Handoff`
  nodes wired with the plan's relationship set (`ABOUT`, `SUPPORTED_BY`,
  `TESTS`, `ANSWERS`, `CONCERNS`, `FROM`, `TO`, `BY`)
- At least one pair of known-but-disconnected entities for `not_in_graph`.

**Verify:** `node scripts/graph-seed.mjs` → entities visible in FalkorDB
Browser; `MATCH (n) RETURN labels(n), count(n)` shows the full set.

---

## Task 2 — Direct graph writes (fail-open)

**Goal:** the system writes to the graph when it learns/observes/hands off —
not via batch projection.

**Files to create:** `lib/_graphWriter.js`
**Files to modify:** `lib/handlers/cron-daily.js`,
`src/services/intelligenceService.js`

**`_graphWriter.js`:** `mergeNode(label, props)` / `mergeEdge(fromLabel,
fromId, rel, toLabel, toId)` — typed, parameterized MERGE helpers. Every call
fail-open: logs a warning, returns null, never throws (agentRunStore convention).

**Write hooks:**
- [x] `cron-daily.js` rung transitions:
  - Sense finds a changed page → `Finding` + `Evidence` + `Handoff(watcher→triage)`
  - Triage verdict material → `Handoff(triage→pursuer)`
  - Pursuit produces a Read → `Read -[:ANSWERS]-> Question` (+ `Question` if new)
  - Each firing → `Session -[:BY]-> Agent`
- [x] `askBahirjee` Stage 3 write-back (intelligenceService ~L6576) →
      `Evidence` + `Finding` about the asked entity — enables
      `answered_from_memory` on re-ask in a new session.
- [x] `MEMORY_GRAPH_ENABLED=0` short-circuits every writer.

**Verify:** fire `cron-daily` logic against a test client → nodes appear in
Browser; flip `MEMORY_GRAPH_ENABLED=0` → run again, nothing written, no error.

---

## Task 3 — Fixed tool catalogue

**Goal:** six typed tools; the model selects, never queries.

**Files to create:** `lib/_graphTools.js`

Each tool: typed arg validation → entity resolution (`MATCH (e:Entity)` on
normalized name — miss ⇒ `unknown_entity` and **no further query**) →
human-authored capped Cypher → result validation → structured result
`{ outcome, tool, path, nodes, memory_ts, truncated }`.

| Tool | Core query |
|---|---|
| `recall(entity)` | bounded `MATCH` over Finding/Read/Belief/Evidence within 2 hops |
| `blast_radius(entity, depth)` | `MATCH p=(e)-[:DEPENDS_ON\|COMPETES_WITH\|PARTNERS_WITH*1..4]-(x) RETURN p`, depth hard-capped |
| `next_agent(entity)` | pending `Handoff -[:TO]-> Agent` reachable from entity's open work |
| `recent_changes(entity, since)` | Finding/Evidence/Read filtered on `ts >= $since`, capped rows |
| `path_between(a, b)` | `CALL algo.SPpaths(...)` — return actual path nodes |
| `load_bearing(limit)` | `CALL algo.pageRank(...)` — ranked entities |

Outcomes enum: `answered_with_path` | `answered_from_memory` |
`not_in_graph` | `unknown_entity` | `graph_unavailable`.

**Verify:** each tool against the seeded graph via a scratch script — depth 1
vs depth 4 return different paths; disconnected pair ⇒ `not_in_graph`; bogus
entity ⇒ `unknown_entity` with zero Cypher executed (log/assert query count).

---

## Task 4 — Graph agent runtime

**Goal:** bounded `Reason → Tool → Observe → Answer` loop.

**Files to modify:** `lib/handlers/gemini.js`, `src/services/promptUtils.js`
**Files to create:** `lib/_graphAgent.js`

- [x] `'graphAgentStep'` added to `SUPPORTED_ACTIONS`, routed to the **light**
      tier; new schema-constrained prompt returning
      `{ tool, args, done, answer? }` only.
- [x] `_graphAgent.js`: loop ≤ `MEMORY_GRAPH_MAX_STEPS` (4); `recall` forced
      first when the question references prior work; every entity named by the
      model must resolve before its tool runs; every claim in the final answer
      must cite a node id present in returned results — else the claim is
      dropped/rejected.
- [x] Response: `{ outcome, answer, tool_trace, path, memory_ts }`.

**Verify:** scripted questions → correct tool selected; a >4-step prompt stops
at 4; a fabricated path in a mocked tool result is rejected by validation.

---

## Task 5 — `/api/graph` route

**Goal:** authenticated entry point, actions `ask` and `activity` only.

**Files to create:** `lib/handlers/graph.js`
**Files to modify:** `api/router.js`

- [x] `applyApiSecurity({ routeKey: 'graph', maxRequests: 30 })` +
      `requireAuthenticatedUser`; `client_id` resolved from the caller's
      profile — request body never supplies it.
- [x] `ask` → `_graphAgent.js`; `activity` → recent Handoff/Finding/Read feed.
      (Also `record_finding` — the fixed, Cypher-free write-back for Q&A.)
- [x] No arbitrary Cypher parameter exists in the request schema.
- [x] Router: `graph: () => import('../lib/handlers/graph.js').then(m => m.handler)`.

**Verify:** curl with/without auth; action outside the allowlist → 400;
response shape stable for tests.

---

## Task 6 — UI integration (minimal)

**Goal:** graph-first Q&A with honest provenance, deferred panel.

**Files to modify:** `src/services/intelligenceService.js` (or a thin
`graphMemory.js` client wrapper), `src/components/IntelligenceDashboard.jsx`
(`handleQnA`), signal/answer card UI.

- [x] `handleQnA` tries `/api/graph` `ask` first:
  - `answered_from_memory` / `answered_with_path` → render answer + provenance
    chip (tool, depth, memory timestamp, path entity names)
  - `unknown_entity` → say so, no fallback search
  - `not_in_graph` / `graph_unavailable` → fall through to existing Stage 1→2
    ladder, labelled "degraded — live search" (never presented as memory)
- [x] Defer the full Memory & Coordination panel if time is short; `activity`
      endpoint stays available for it.

**Verify:** re-ask a seeded question in a fresh session → memory badge;
`MEMORY_GRAPH_ENABLED=0` → degraded badge appears, no crash.

---

## Task 7 — Tests + demo assets

**Files to create:** `scripts/graph-roundtrip.test.mjs`; README section.

**Test (fake graph client, `_fakePostgrest.mjs` style):**
- [x] unknown entity → `unknown_entity`, zero queries executed
- [x] known disconnected pair → `not_in_graph`
- [x] `MEMORY_GRAPH_ENABLED=0` → `graph_unavailable`, no writes
- [x] tenant A resolves only `bahirjee:{A}` — never B's graph
- [x] fabricated/invalid path rejected by `accepts()` validation
- [x] re-ask returns `answered_from_memory`
- [x] depth-1 vs depth-4 `blast_radius` return different path sets
- [x] `path_between` returns real `algo.SPpaths` output; `load_bearing` returns
      ranked entities
- [x] watcher→triage→pursuer handoff visible to a second reader (no local state)
      — verified live: `next_agent(ShipSwift)` returns the seeded pending
      watcher→triage handoff via graph traversal only

**README:** graph model + node/edge schema, six-tool catalogue with the
human-authored Cypher, `algo.SPpaths`/`algo.pageRank` usage, Docker setup,
seed instructions, removal proof, AI-assistant disclosure, limitations.

**Demo sequence** (record after tests pass): seed → Browser walk-through →
watcher→triage→pursuer → new-session `answered_from_memory` → depth paths →
unknown/not_in_graph → `MEMORY_GRAPH_ENABLED=0` rerun → degraded.

---

## Deferred (explicitly out of same-day scope)

- Real Supabase → graph backfill script (seed stands in)
- Belief `SUPERSEDES` chain maintenance, `CONTRADICTED_BY` inference
- Full Memory & Coordination UI panel (the `activity` API supports it)
- FalkorDB Cloud + TLS deploy; entity↔entity edge *derivation* from signals
- Broadening the outcome/test matrix to all 15 acceptance items
