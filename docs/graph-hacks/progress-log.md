# Track 2 — FalkorDB Memory & Coordination: Implementation Log

**Branch:** `falkordb-memory-graph` (from `main`) — committed `7f3aaf3`, pushed to origin
**Plan:** [docs/graph-hacks/plan.md](./plan.md)
**Status:** Code complete + verified against **live FalkorDB Cloud** (seed, all six tools, and the full `askGraph` loop with real Gemini). Remaining: demo video, deployment.

Update this file as work lands — it is the single ledger of what exists, what's verified, and what is still open.

---

## Architecture decisions (locked)

- **Additive, not a rewrite.** Supabase stays the system of record (auth, reports, product data). FalkorDB is authoritative for Track 2 *reads* but **rebuildable from Supabase** — a projection, never a second truth.
- **Tenant isolation = the graph boundary.** One named graph per client: `bahirjee:{client_id}`, minted only in `lib/_graph.js` from a UUID-validated client_id resolved server-side. A request can never name a tenant it doesn't own.
- **LLM picks tools, humans write queries.** The model selects one of six fixed tools + typed args through a schema-constrained light-tier call (`graphAgentStep`). No code path lets model output become Cypher.
- **Fail-open everywhere.** Every read returns `{ ok:false, outcome:'graph_unavailable' }`; every write logs and returns null. `MEMORY_GRAPH_ENABLED=0` is the removal test — memory, handoffs, and paths visibly die while the product keeps working.
- **Honest outcomes:** `answered_with_path` | `answered_from_memory` | `unknown_entity` (no query ran) | `not_in_graph` (known but disconnected — a coverage fact, not a claim of absence) | `graph_unavailable`. Outcomes are derived from tool results, not the model's say-so.

---

## Implemented

| File | What it does | Verified |
|---|---|---|
| `package.json` / `package-lock.json` | `falkordb@6.8.0` dep + `npm run test:graph` script | ✓ |
| `lib/_graph.js` | Connection (cached per warm process, poisoned-conn reset), `graphNameFor()` UUID gate, `graphQuery`/`graphRoQuery` ($params only), `ensureSchema` (unique constraint + index per label), `graphPing`, `isGraphEnabled`, `maxGraphSteps`, `__setGraphClientForTests` seam | ✓ (disabled path + fake-client tests; live ping pending) |
| `lib/_graphTools.js` | Six tools — `recall`, `blast_radius`, `next_agent`, `recent_changes`, `path_between` (`algo.SPpaths`), `load_bearing` (`algo.pageRank`). Each: typed args → `resolveEntity` name_key gate → capped human-authored Cypher → validated result | ✓ (fake client) |
| `lib/_graphWriter.js` | `mergeNode`/`mergeEdge` (label+rel whitelists), `graphWriteCompany/Entity/Session/Finding/Handoff/Read/Question/QaFinding`, `graphEnsureAgents`, `graphCompleteHandoff`. Stable ids: `fnd:`, `ev:`, `ho:`, `agt:`, `ent:`, `co:` | ✓ (write-call assertions) |
| `lib/_graphAgent.js` | Reason→Tool→Observe loop: ≤4 steps, forced `recall` first on prior-work questions (capitalized-token entity probe), terminal outcomes break early, grounding check rejects answers naming entities no tool returned, fallback answers describe the real top path | ✓ (scripted `stepFn` tests) |
| `lib/handlers/gemini.js` | `graphAgentStep` in `SUPPORTED_ACTIONS` → `handleGraphAgentStep`: light tier, schema `{done, tool?, args?, answer?}`, 1200 max tokens | ✓ (syntax; live LLM call pending) |
| `src/services/promptUtils.js` | `PROMPTS.graphAgentStep` — tool-picker prompt | ✓ (syntax) |
| `lib/handlers/graph.js` | `/api/graph`: `ask` → agent loop; `activity` → recent Handoff/Finding/Read/Session feed; `record_finding` → Q&A write-back. `applyApiSecurity` + `requireAuthenticatedUser` + per-user rate limit; `client_id` from profile only; no Cypher param exists | ✓ (syntax; live pending) |
| `api/router.js` | `graph` route registered | ✓ (test:router) |
| `lib/handlers/cron-daily.js` | Ladder graph writes: Session on firing; Finding+Evidence per material source-watch change; Handoff watcher→triage; Handoff triage→pursuer (completed on pickup); Read→Question on pursuit; handoff completion | ✓ (syntax; live pending) |
| `src/services/intelligenceService.js` | askBahirjee Stage 3: accepted answers → `graphRecordFinding` via `/api/graph` (fire-and-forget; browser can't speak Redis protocol) | ✓ (syntax; live pending) |
| `src/services/graphMemory.js` | Browser client: `graphAsk`, `graphAnswered`, `graphProvenanceLine` (tool · path · memory-ts line), `graphRecordFinding` | ✓ (syntax; 1.1KB chunk) |
| `src/components/IntelligenceDashboard.jsx` | `handleQnA`: graph-first — `answered_*` returns answer + provenance line; `unknown_entity`/`not_in_graph`/`graph_unavailable` fall through to existing ladder | ✓ (build) |
| `scripts/graph-seed.mjs` | Synthetic "Acme Freight" tenant: 1 Company, 3 Agents, ~12 Entities, 4-deep DEPENDS_ON chain, COMPETES_WITH crossing, disconnected Zendesk (for `not_in_graph`), pending watcher→triage Handoff, Evidence/Question/Read/Session | ✓ seeded live (24 nodes, 33 edges on `bahirjee:00000000-…-000d`) |
| `scripts/graph-roundtrip.test.mjs` | **15 checks, all passing** — see below | ✓ |
| `.env.example` | Commented FalkorDB block (lines ~218–238): `falkor://` local/free, `falkors://` paid/TLS | ✓ |
| `README.md` | Track 2 section: architecture, schema, tool table, loop, degraded mode, seed/test commands, AI-assistant disclosure | ✓ |

## Verification status

| Check | Result |
|---|---|
| `node scripts/graph-roundtrip.test.mjs` | **15/15 pass** — tenant naming+UUID gate, disabled→`graph_unavailable` w/ zero queries, unknown entity→no query, recall memory, blast depth 1 vs 4 (+ depth spliced into Cypher asserted), real SPpaths route, disconnected→`not_in_graph`, pageRank ranking, Q&A write lands on tenant-A graph only, agent loop answered_with_path, fabricated-entity answer rejected (path described instead), 4-step cap, terminal unknown_entity at step 1, forced recall-first, grounding vocab check |
| `npm run test:router` / `test:ask` / `test:cron` | pass — no regressions |
| `npm run build` | clean; `graphMemory` browser chunk 1.14KB — no falkordb/redis leakage |
| `node --check` on all new/edited files | pass |
| **Live FalkorDB ping** | ✓ connected (free tier, `falkor://`, no TLS) |
| **Seed live** | ✓ 24 nodes / 33 edges on `bahirjee:00000000-0000-4000-8000-00000000000d` |
| **Live tools (all six)** | ✓ recall→`answered_from_memory` (7 nodes); blast d1 vs d4 differ; `next_agent(ShipSwift)`→pending watcher→triage handoff; `path_between(ShipSwift→State PowerGrid)`→3 real SPpaths routes; `load_bearing`→pageRank (PowerGrid/Equinix/AWS top); `recent_changes`→2 nodes; `unknown_entity`(Zorblax) and `not_in_graph`(AWS→Zendesk) both correct |
| **Live write-back → recall round trip** | ✓ `graphWriteQaFinding` → `recall('ShipSwift')` surfaces the QA finding + evidence + seeded finding in a new session |
| **Live `askGraph` (real Gemini + real graph)** | ✓ all five demo questions produce real outcomes: `next_agent(ShipSwift)`→grounded answer naming triage + the finding; `blast_radius(AWS)`→real path; `path_between(Acme Freight→State PowerGrid)`→5-hop route; `load_bearing`→ranked names; `recall`→memory incl. Q&A write-backs |

## Live-test bugfixes (caught on real FalkorDB)

1. **Company-id split-brain** — seed wrote `co:acme`, writer anchors `co:{clientId}` → two Company nodes. Seed now uses the canonical `co:{client_id}` id.
2. **`graphWriteCompany` clobber** — `graphWriteCompany(cid,{})` overwrote `name`/`name_key` with "the company" via MERGE+SET → founder's company went `unknown_entity`. Now only sets name/domain when provided.
3. **Multi-word probe swallowing** — `probeEntity('Does ShipSwift')` missed because the capitalised-phrase regex fuses a leading stopword with the entity. Shared `probeQuestionEntities()` probes the phrase, then each word; used by both the writer (entity anchoring) and the agent (forced-recall hint).
4. **QA findings invisible to `recall(entity)`** — write-back anchored ABOUT the company only; now links Finding+Evidence to up to 2 entities named in the question.
5. **Light model thinks aloud in `tool`** — "blast_radiuschain_or_equiv..." burned all 4 steps as unknown_tool. `normalizeToolName` recovers prefix/substring matches; prompt now demands a single bare name.
6. **Model omits `args`** — schema now `required: ["done","args"]` + `propertyOrdering`; `hydrateArgs` fills/verifies entity args from question probes (a bad model arg like "ShipSwift pricing change" is replaced by the probed entity, never trusted).
7. **Weak fallback answers** — rejected/absent model prose now describes what tools returned: top path, pending handoff (from→to + work), ranked names, or memory node names.

## Pending

1. Decide demo tenant: real `client_id` (profiles lookup) vs `DEV_AUTH_BYPASS=true` + `DEV_BYPASS_CLIENT_ID=00000000-0000-4000-8000-00000000000d`
2. Browser demo: `npm run dev` → Ask Bahirjee → seed questions → provenance line; FalkorDB Browser open on the seeded graph
3. Deploy: add env vars to Vercel project; confirm `/api/graph` works serverless (connect-per-invocation)
4. Demo script run-through (seeded graph → re-ask from memory → depth 1 vs 4 → handoff → unknown → disconnected → `MEMORY_GRAPH_ENABLED=0` degradation)
5. Optional/deferred: Memory & Coordination UI panel (`activity` endpoint already feeds it), Belief/`SUPERSEDES` machinery, real Supabase backfill script

## Env (values live in `.env`, never committed)

```bash
FALKORDB_URL=falkor://<host>:<port>   # free tier: no TLS → falkor://, NOT falkors://
FALKORDB_USERNAME=<instance user>
FALKORDB_PASSWORD=<instance password>
MEMORY_GRAPH_ENABLED=1
MEMORY_GRAPH_MAX_STEPS=4
# optional: DEV_AUTH_BYPASS=true, DEV_BYPASS_CLIENT_ID=<uuid> for login-free local demo
```

## Incidents / notes

- **2026-10-18:** real credentials were briefly pasted into `.env.example` (a tracked file). Removed before any commit — no git cleanup needed. `.env` is git-ignored; I cannot read it, all credential handling is user-side.
- **FalkorDB schema quirk found live:** constraints are a MODULE command (`GRAPH.CONSTRAINT`), not Cypher — `ensureSchema` uses `graph.constraintCreate('UNIQUE','NODE',label,'id')` and treats "already indexed/exists" errors as idempotent. `CREATE INDEX FOR (n:L) ON (n.prop)` does work via Cypher.
- **Cloud username is `falkordb`-style instance user, not `default`** — and the port is not necessarily 6379.
- **Free-tier caveats:** no TLS, ~1-day idle shutdown, ~7-day deletion — re-wake the instance before demoing.
- **Password contains `@`** — fine as a separate `.env` var; do not embed it in the URL.
- `cron-daily` graph writes only fire for clients with `auto_run_cadence` configured; for the demo use seed data + direct writes rather than waiting on cron.
