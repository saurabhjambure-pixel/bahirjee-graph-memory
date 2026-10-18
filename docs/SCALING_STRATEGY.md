# Bahirjee Platform — Architecture & Scaling Strategy

This document describes how the Bahirjee Intelligence Platform scales its multi-agent intelligence pipeline, serverless compute, and persistent data layers while maintaining strict cost discipline, latency bounds, and data reliability.

---

## 1. High-Level Scaling Philosophy

Autonomous strategic intelligence requires balancing two opposing forces:
1. **Depth & Veracity**: Performing dozens of targeted search queries, reading deep web sources, monitoring primary competitor pages, and synthesizing complex market patterns.
2. **Cost & Operational Discipline**: Keeping execution costs under $0.50 per comprehensive run, staying within serverless function timeout limits, and preventing runaway token consumption.

To solve this, Bahirjee decouples ingestion, deterministic synthesis, and judgment into distinct architectural tiers.

---

## 2. Serverless Execution Scaling: The Stepped Worker

### The Challenge
A full intelligence run takes 2–3 minutes, making 22+ search requests, up to 8 deep page scrapes, and several LLM batch calls. Standard serverless functions on platforms like Vercel have execution timeouts of 15s (Hobby) to 60s (Pro). Monolithic execution in a single HTTP request causes frequent timeouts and leaves jobs permanently stalled.

### The Solution: Stepped Checkpoints & Self-Retriggering
The orchestrator in `lib/_intelligenceWorker.js` executes the pipeline in discrete, durable stages:

```
[Job Enqueued]
       │
       ▼
┌──────────────┐   Step 1 (Context & Queries)   ┌──────────────────────┐
│  Worker #1   │ ─────────────────────────────> │ Postgres Checkpoint  │
└──────────────┘                                └──────────────────────┘
       │ triggers next step via internal HTTP               │
       ▼                                                    ▼
┌──────────────┐   Step 2 (Tavily Search & Reads) ┌──────────────────────┐
│  Worker #2   │ ─────────────────────────────> │ Postgres Checkpoint  │
└──────────────┘                                └──────────────────────┘
       │ triggers next step                                 │
       ▼                                                    ▼
┌──────────────┐   Step 3 (Analyze Signals)      ┌──────────────────────┐
│  Worker #3   │ ─────────────────────────────> │ Postgres Checkpoint  │
└──────────────┘                                └──────────────────────┘
       │ triggers next step                                 │
       ▼                                                    ▼
┌──────────────┐   Step 4 (Synthesis & Persist)  ┌──────────────────────┐
│  Worker #4   │ ─────────────────────────────> │ Report Published     │
└──────────────┘                                └──────────────────────┘
```

1. **Durable State**: State is persisted in `intelligence_jobs.step_state` (JSONB) in Postgres at each boundary.
2. **Invocation Budget**: Each step operates within `STEP_MAX_MS` (default 45,000ms), ensuring completion well within serverless ceilings.
3. **M2M Self-Retriggering**: When a step completes, the worker issues an asynchronous authenticated `POST /api/intelligence-worker` carrying `x-bahirjee-internal-key` to claim and execute the next step.
4. **Idempotency**: Runs track a unique `run_id`, preventing duplicate synthesis or double billing if a step retries.

---

## 3. Cost & Token Budgeting

### 3.1 Tiered Model Routing
LLM calls are routed **by action**, not by uniform provider preference:

| Tier | Actions | Model / Engine | Cost per Call |
| :--- | :--- | :--- | :--- |
| **Bulk Analytical Tier** | `buildContext`, `generateQueries`, `analyzeSignals`, `extractDocumentIntel`, `answerQuestion` | Gemini Flash | ~$0.005–$0.015 |
| **Reasoning Tier** | `interpretShifts`, `generateSummary`, `generateDecisionBrief` | `gemini-2.5-pro` | ~$0.08–$0.12 |
| **Zero-LLM Deterministic Tier** | Pattern clustering, shift identification, blind spots, news filtering (`newsScorer.js`) | Deterministic JS | **$0.00** |
| **Fallback Tier** | Cross-provider resilience | Sarvam | Emergency fallback |

By restricting the expensive reasoning tier (`gemini-2.5-pro`) to only the final 2–3 judgment actions, the total cost of a full run is kept to **~$0.30–$0.40**, compared to $2.00+ if reasoning models were used throughout.

### 3.2 Observation Ceiling & Proportional Thinning
The dominant cost driver during signal analysis is the **observation volume** sent to Gemini.
- A hard ceiling is enforced: `MAX_OBSERVATIONS_TOTAL = 200`.
- **Proportional Thinning**: If raw search and scraping gather 350 observations, naive truncation would discard the latest or rarest evidence (e.g., regulatory filings or tenders). Instead, `capObservations()` calculates proportional representations across each `source_class` (tenders, filings, reviews, primary sources, general web) and thins each category evenly.

---

## 4. Rate Limiting & Concurrency Scaling

### Distributed Sliding Window
Rate limiting is enforced at the API gateway layer via `applyApiSecurity()` (`lib/_security.js`):
- **Production Mode**: Backed by Upstash Redis (`@upstash/redis`) using a sliding window algorithm across serverless instances.
- **Fail-Open Fallback**: If Redis is unavailable or unconfigured, an in-memory LRU cache handles local rate limiting without interrupting user traffic.

### Atomic Concurrency Guards
To prevent users from launching concurrent browser tabs to bypass freemium run limits:
- Database RPC `reserve_report_run` uses PostgreSQL `FOR UPDATE` row locks on the user's `profiles` record.
- Increments and validations are atomic, guaranteeing that free users cannot exceed their 1-report quota.

---

## 5. Knowledge Store & Vector Scaling

### 5.1 Reusable Company Contexts (`company_contexts`)
To avoid re-running expensive context extraction (Tavily search, LinkedIn enrichment, and Gemini context inference) every time an analysis is triggered:
- Context is versioned and stored per `(client_id, target_domain)`.
- Subsequent runs reuse the confirmed context and only execute a lightweight `mergeContext` patch when the founder supplies new sources.

### 5.2 Unified pgvector Knowledge Store (`document_chunks`)
The pgvector database store in Supabase (`document_chunks`) uses a polymorphic `kind` column:
- `uploaded_doc`: Parsed and embedded pitch decks/whitepapers.
- `signal`: Confirmed market signals from prior runs.
- `observation`: Verified web findings from Q&A.

**Scaling Impact**: When a user asks a question in the report workspace (`askBahirjee`), the platform queries `match_document_chunks` first. If answers exist in local vector memory, the answer is synthesized immediately without paying for new Tavily web searches or external scraping.