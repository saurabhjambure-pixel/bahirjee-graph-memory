# Bahirjee Project Execution Brief

Authoritative source of truth for platform architecture, execution model, and provider routing.

This document describes the current product and codebase. If any other document conflicts with this file on routing, providers, or execution ownership, trust this file.

---

## 1. Product Shape

Bahirjee is a strategic intelligence platform for founders and strategy leaders with an admin operations layer. It accepts a company URL, optional LinkedIn hint, and optional uploaded documents, builds a company context, runs an 11-step intelligence pipeline, and persists an attested decision brief plus continuity state in Supabase.

### Primary Surfaces:
1. **Founder Workflow**: Auth → Intake (URL / LinkedIn / doc) → Context Gate / Review → Analyzing Screen → Report Workspace.
2. **Shared Report Workflow**: `/report/:shareToken` (read-only, identity-based access control).
3. **Admin Workflow**: `/admin` → Clients → Client Detail → Users / Email Allowlist / Reports / Run Intelligence.

---

## 2. Current Architecture

### Frontend
- React 18 SPA with React Router 7 and Tailwind CSS.
- Main founder workflow controller: [src/components/IntelligenceDashboard.jsx](../src/components/IntelligenceDashboard.jsx)
- Admin operations console: [src/pages/admin/ClientDetail.jsx](../src/pages/admin/ClientDetail.jsx)
- Shared brief viewer: [src/components/ReportViewer.jsx](../src/components/ReportViewer.jsx)

### Backend & API
- **Single Vercel Serverless Function**: [api/router.js](../api/router.js) dispatches `/api/*` requests dynamically to modular route handlers in `lib/handlers/*.js` to respect Vercel Hobby plan's 12-function limit.
- **Request Security & Rate Limiting**: [lib/_security.js](../lib/_security.js) (CORS, Upstash Redis sliding window, in-memory fallback).
- **Authentication**: [lib/_auth.js](../lib/_auth.js) (`requireAuthenticatedUser`, service-role client, M2M internal key validation).
- **Intelligence Job Management**: [lib/handlers/intelligence.js](../lib/handlers/intelligence.js) (create, resume, and poll jobs).
- **Intelligence Worker Entrypoint**: [lib/handlers/intelligence-worker.js](../lib/handlers/intelligence-worker.js) and stepped pipeline driver [lib/_intelligenceWorker.js](../lib/_intelligenceWorker.js).
- **In-Process Dispatcher**: [lib/_internalRouteClient.js](../lib/_internalRouteClient.js) enables server-owned worker execution to reuse existing pipeline services in-process.

### Data Layer
Supabase PostgreSQL is the system of record with RLS enabled across all tables:
- `clients`, `profiles`, `email_allowlist`
- `intelligence_jobs`
- `reports`
- `company_contexts` (reusable context per client/domain)
- `observations`, `patterns`, `shifts`, `blind_spots`, `opportunities`, `impact_events`
- `brief_cards`, `brief_card_evidence`, `company_memory_state`
- `entity_sources`, `entity_source_snapshots`, `tracked_entities`, `entity_relationships`
- `document_chunks` (pgvector store for uploaded docs, signals, and Q&A findings)
- `interactions`

---

## 3. Execution Ownership Model

The long-running intelligence analysis is completely server-owned:

### Founder Flow
1. The browser executes short initial context acquisition/scraping and presents the **Context Review** screen so the founder can inspect and edit inferred context.
2. Upon confirmation, the browser submits `POST /api/intelligence`.
3. The server reserves the run atomically via the `reserve_report_run` RPC, creates an `intelligence_jobs` row, and asynchronously triggers the worker (`POST /api/intelligence-worker`).
4. The founder UI polls `GET /api/intelligence?id=...` and renders live step progress.
5. When the job completes, the finished report loads from Supabase into the Report Workspace. The run completes even if the founder closes the browser tab.

### Admin Flow
1. Admin triggers an analysis on a client from [src/pages/admin/ClientDetail.jsx](../src/pages/admin/ClientDetail.jsx).
2. The UI submits `POST /api/intelligence` with `buildContextOnServer: true`.
3. The worker builds context server-side and executes the full pipeline end-to-end.
4. The admin UI polls job status and renders live progress logs.

---

## 4. The 11-Step Intelligence Pipeline

Pipeline orchestration is defined in [src/services/intelligenceService.js](../src/services/intelligenceService.js) and executed by [lib/_intelligenceWorker.js](../lib/_intelligenceWorker.js):

1. **Context Building**: Reuses verified context from `company_contexts` if available. If new documents/sources are added, folds them in using a quote-bound `mergeContext` patch. If no context exists, scrapes site + LinkedIn and enriches via Gemini Flash.
2. **Query Generation**: Deterministic queries first; Gemini Flash fallback for targeted extras.
3. **Search**: Tavily search across 22 queries. 9 queries are reserved for **Source Tiers** ([src/services/sourceTiers.js](../src/services/sourceTiers.js)) with domain allowlists (government, regional press, research, reviews, analyst, discourse, supply).
4. **Deep Reads**: Scrapes key source pages via Parallel AI Extract; Exa fallback if extracted text is under 500 characters.
5. **Source Watch**: Re-reads tracked entities' primary pages ([src/services/sourceWatch.js](../src/services/sourceWatch.js)) from `entity_sources` (pricing, changelogs, careers, status pages) and emits an observation only when content hashes have changed.
6. **Structured Connectors**: Direct API queries to live tenders (SAM.gov, UK Contracts Finder, GeM), regulatory filings (SEC EDGAR, Companies House), and social discussions ([lib/handlers/connectors.js](../lib/handlers/connectors.js)).
7. **Signal Analysis**: Gemini Flash analyzes observations into structured signals. Every signal is checked against the **Grounding Guard** (`filterGroundedSignals()`), dropping any signal citing a URL not present in that batch.
8. **Synthesis**: Patterns, shift candidates, blind spots, and opportunities are synthesized deterministically in JavaScript. Shift *interpretation* is then performed on the **Gemini Reasoning Tier** (`gemini-2.5-pro`).
9. **Summary & News**: `gemini-2.5-pro` synthesizes the founder-facing executive brief. News extraction uses **zero LLM calls**, filtering and scoring items deterministically via [src/services/newsScorer.js](../src/services/newsScorer.js).
10. **Attest**: Validates the generated brief against policy constraints ([src/agents/policies/briefPolicy.js](../src/agents/policies/briefPolicy.js)), verifying source traces, confidence limits, and lack of imperative advice language.
11. **Persist**: Stores report, entity watchlist, relationships, company contexts, vector embeddings, and memory state in Supabase.

---

## 5. Provider & LLM Routing

### LLM Gateways
- **Gemini**: [lib/handlers/gemini.js](../lib/handlers/gemini.js) — Primary provider. Handles schema-constrained JSON, retry with backoff, and model selection.
- **Claude**: [lib/handlers/claude.js](../lib/handlers/claude.js) — Fully wired, off by default. Claude Haiku is active in [lib/_vision.js](../lib/_vision.js) for transcribing scanned PDF pages.
- **Groq**: [lib/handlers/groq.js](../lib/handlers/groq.js) — Wired but off by default.
- **Sarvam**: [lib/handlers/sarvam.js](../lib/handlers/sarvam.js) — Cheap cross-provider fallback.

### Routing by Action
- `buildContext`: Gemini Flash (overridable via `VITE_CONTEXT_LLM_PROVIDER`)
- `mergeContext`: Gemini Flash
- `generateQueries`: Gemini Flash
- `analyzeSignals`: Gemini Flash (bulk processing)
- `extractDocumentIntel`: Gemini Flash (quote-bound extraction)
- `answerQuestion`: Gemini Flash (grounded Q&A)
- `interpretShifts`: **`gemini-2.5-pro`** (Reasoning tier)
- `generateSummary`: **`gemini-2.5-pro`** (Reasoning tier)
- `generateDecisionBrief`: **`gemini-2.5-pro`** (Reasoning tier)
- `generateNewsLines`: **Deterministic JS** (`newsScorer.js`, no LLM)

### Temporal evidence policy

Evidence is separated by WHEN it happened, not by when it was fetched. Three bands, built
once per run in [src/services/temporalPolicy.js](../src/services/temporalPolicy.js) and
threaded through retrieval, prompting, classification and every surface.

| Band | Window | What it is | Where it may appear |
|------|--------|------------|---------------------|
| Current (`anchor`) | six-month, calendar | A dated event: funding, a hire, a pricing change, a policy notice | News, signal cards, summary |
| Context (`supporting_context`) | twelve-month, calendar | Reports, research, analyst notes, reviews, market sizing | Attached to an anchor, labelled |
| Historical (`historical_context`) | anything older | Still valuable, describes the past | Attached to an anchor, labelled |

Windows are **calendar months**, not `months × 30`. Six months back from September 19th is
March 19th, because that is the boundary we have to be able to explain out loud.

**Date precedence.** `event_date` > `published_date` > undated. `retrieved_at` is ingestion
time and is **never** used as an event date — that substitution is the bug this policy
exists to prevent. A 2024 article crawled today is a 2024 article.

The one exception is a Source Watch diff. That step emits an observation only where a
page's content hash CHANGED since the last run, so the diff itself is evidence the change
is new, and observation time genuinely bounds when it happened. It is recorded at `medium`
confidence, never `high`.

**Undated evidence supports, it never anchors.** The general web index returns no
publication date at all, so this is the common case rather than an edge case — and it is
exactly the material that used to become "news" on the strength of its crawl time. Undated
evidence is counted separately from dated context: a run that is mostly undated has a
retrieval problem, not a judgement one, and the disclosure should be able to say which.

**Nothing is deleted.** Temporal classification decides where evidence may be *shown*. It
never decides whether evidence is *kept*. Every observation, signal and report is retained
whatever band it falls in; older material reaches the founder attached to the recent event
it explains, carrying an explicit "Historical context" label. `v27_temporal_evidence.sql`
is additive only — no backfill, no `UPDATE`, no `DELETE` — and legacy rows keep null
temporal fields, which read as "unknown" and therefore never as current.

**Retrieval carries the window.** Each query bucket declares `current`, `context` or
`profile` in `QUERY_BUCKET_WINDOWS`. Profile lookups (competitor discovery, context
assembly) are deliberately unbounded: a publication-date bound on the general index filters
undated pages *out*, which would lose the company homepage those queries exist to find.

**Legacy note.** `structured_signals.timestamp` is ingestion time and always was. Read
`event_date`. Signals written before v27 have `temporal_role` null; surfaces treat null as
"not current" rather than inventing a date.

### Web Scraping & Search
- **Search**: Tavily via [lib/handlers/search.js](../lib/handlers/search.js)
- **Primary Scraper**: Parallel AI Extract via [lib/handlers/scrape.js](../lib/handlers/scrape.js)
- **Scraper Fallback & Neural Search**: Exa via [lib/handlers/scrape.js](../lib/handlers/scrape.js) and [lib/handlers/exa.js](../lib/handlers/exa.js)

---

- Gemini: [lib/handlers/gemini.js](../lib/handlers/gemini.js) — the primary gateway, three tiers
  (`MODEL_TIERS`)
- Claude: [lib/handlers/claude.js](../lib/handlers/claude.js) — wired, off by default; Claude Haiku
  is on for scanned-PDF transcription ([lib/_vision.js](../lib/_vision.js))
- Sarvam: [lib/handlers/sarvam.js](../lib/handlers/sarvam.js) — the cheap cross-provider fallback
- Groq: [lib/handlers/groq.js](../lib/handlers/groq.js) — wired, off by default

Current routing (Gemini tiers in [lib/handlers/gemini.js](../lib/handlers/gemini.js)):

- `buildContext`, `mergeContext`, `analyzeSignals`, `extractDocumentIntel`, `answerQuestion`:
  `gemini-3.8-flash` (heavy)
- `generateQueries`, `frameDecision`: `gemini-3.5-flash-lite` (light)
- `generateSummary`, `generateDecisionBrief`, `interpretShifts`: `gemini-3.1-pro-preview`, falling
  back to GA `gemini-3.8-flash` (reasoning)
- News: no LLM call — scored by [src/services/newsScorer.js](../src/services/newsScorer.js)
  (`generateNewsLines` was deleted)

### Typed decisions (Jev)

TypeSafe Jev, through [lib/handlers/jev.js](../lib/handlers/jev.js) and
[src/services/jevService.js](../src/services/jevService.js), returns scores and yes/no answers
(no text) for six decisions: deep-read selection, evidence triage, Source Watch changes,
structural findings, news relevance, and an advisory read of the brief. Each runs in **shadow**
by default — recorded in `verification.jev`, changing nothing — until its `JEV_<USE_CASE>` is set
to `on`. Server-only: `/api/jev` accepts just the pipeline's internal key.

### Search and scraping

- Search: Tavily through [lib/handlers/search.js](../lib/handlers/search.js)
- Primary extraction: Parallel AI through [lib/handlers/scrape.js](../lib/handlers/scrape.js)
- Fallback extraction and content/search support: Exa through [lib/handlers/scrape.js](../lib/handlers/scrape.js) and [lib/handlers/exa.js](../lib/handlers/exa.js)

Do not describe the scraper stack as “Firecrawl primary” or the model stack as “Gemini only.” Those statements are stale.

## 6. Key Files

### Backend & API
- [api/router.js](../api/router.js) — The single Vercel serverless function router.
- [lib/handlers/intelligence.js](../lib/handlers/intelligence.js) — Job submission and status.
- [lib/handlers/intelligence-worker.js](../lib/handlers/intelligence-worker.js) — Worker endpoint.
- [lib/_intelligenceWorker.js](../lib/_intelligenceWorker.js) — Stepped pipeline driver.
- [lib/handlers/connectors.js](../lib/handlers/connectors.js) — Tenders, filings, and social APIs.
- [lib/handlers/upload.js](../lib/handlers/upload.js) — PDF/DOCX parsing + vision recovery.
- [lib/handlers/cron-runs.js](../lib/handlers/cron-runs.js) / [lib/handlers/cron-daily.js](../lib/handlers/cron-daily.js) — Weekly and daily automated schedulers.

### Core Shared Services
- [src/services/intelligenceService.js](../src/services/intelligenceService.js) — Main pipeline orchestrator.
- [src/services/companyContextService.js](../src/services/companyContextService.js) — Reusable company context lifecycle (dual browser/server writer).
- [src/services/targetService.js](../src/services/targetService.js) — Multi-target CRUD (company, products).
- [src/services/productService.js](../src/services/productService.js) — Product profiles and query lens.
- [src/services/agendaService.js](../src/services/agendaService.js) — The Agenda (open questions, reads, daily checks).
- [src/services/cadenceService.js](../src/services/cadenceService.js) — Scheduling cadence management.
- [src/services/decisionSessionService.js](../src/services/decisionSessionService.js) — Interactive decision weighing sessions.
- [src/services/signalTaxonomy.js](../src/services/signalTaxonomy.js) — Canonical categories and display groupings.
- [src/services/sourceTiers.js](../src/services/sourceTiers.js) — Allowlisted source tiers and geo-routing.
- [src/services/sourceWatch.js](../src/services/sourceWatch.js) — Primary source change detection.
- [src/services/ragService.js](../src/services/ragService.js) — Unified pgvector chunk store and retrieval.
- [src/services/promptUtils.js](../src/services/promptUtils.js) — LLM prompt templates and schemas.

## 7. Documentation Hierarchy

1. **[docs/PROJECT_EXECUTION_BRIEF.md](./PROJECT_EXECUTION_BRIEF.md)**: Authoritative architecture, execution model, and provider routing.
2. **[docs/DEPLOYMENT.md](./DEPLOYMENT.md)**: Production deployment guide for Vercel, Supabase, and Upstash.
3. **[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md)**: Failure mode resolution and operational runbook.
4. **[docs/SCALING_STRATEGY.md](./SCALING_STRATEGY.md)**: Pipeline stepped execution and cost control strategy.
5. **[docs/AUTHENTICATION.md](./AUTHENTICATION.md)**: Access control, roles, and security model.
