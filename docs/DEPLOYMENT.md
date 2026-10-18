# Bahirjee Platform — Deployment & Production Guide

This guide details the end-to-end deployment process for the Bahirjee Intelligence Platform across **Vercel** (Frontend & Serverless API) and **Supabase** (Postgres, Auth, Storage, and pgvector).

---

## 1. Architecture Overview

- **Frontend**: React 18, React Router 7, Vite 5, Tailwind CSS (built to `dist/`).
- **Backend / API**: A **single Vercel Serverless Function** (`api/router.js`) that dynamically dispatches incoming requests to route handlers under `lib/handlers/*.js`.
  - *Why single function?* The Vercel Hobby plan restricts deployments to a maximum of 12 serverless functions. Because Vite does not provide automatic API bundling (unlike Next.js or SvelteKit), all serverless logic lives outside of `/api` inside `/lib` and is served via `vercel.json` rewrite (`/api/(.*) -> /api/router?route=$1`).
  - **Rule**: Never create additional `.js` files inside `/api/`.
- **Database & Auth**: Supabase PostgreSQL (with Row-Level Security, triggers, `SECURITY DEFINER` RPCs, and `pgvector`).
- **Distributed Cache / Rate Limiting**: Upstash Redis (REST API) with in-memory fallback.
- **Worker Execution**: Serverless stepped worker (`lib/handlers/intelligence-worker.js` and `lib/_intelligenceWorker.js`) executing durable intelligence jobs with self-retriggering checkpoints.

---

## 2. Environment Variables

Configure these variables in your Vercel Project Settings and local `.env` file.

### Frontend Variables (Vite — prefix `VITE_`)

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `VITE_SUPABASE_URL` | **Yes** | Public Supabase project URL | `https://xyzcompany.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | Public Supabase anonymous key | `eyJhbGciOi...` |
| `VITE_CONTEXT_INPUT_CHAR_LIMIT` | No | Character limit for input text | `50000` |
| `VITE_LLM_PRIMARY` | No | Primary LLM provider | `gemini` |
| `VITE_LLM_REASONING` | No | Reasoning tier provider | `gemini` (uses `gemini-2.5-pro`) |
| `VITE_LLM_LIGHT` | No | Light analytical provider | `gemini` |
| `VITE_LLM_FALLBACK` | No | Fallback provider | `sarvam` |
| `VITE_CONNECTORS_ENABLED` | No | Enable live tenders/filings connectors | `false` |
| `VITE_SIGNAL_QUOTE_BINDING` | No | Enforce strict verbatim quotes on web signals | `false` |

### Server-Side Variables (Vercel Project Settings)

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `SUPABASE_URL` | **Yes** | Supabase project API URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_ANON_KEY` | **Yes** | Supabase anon key (used in `auth-link`) | `eyJhbGciOi...` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service-role secret key | `eyJhbGciOi...` |
| `GEMINI_API_KEY` | **Yes** | Google AI Studio Gemini API Key | `AIzaSy...` |
| `TAVILY_API_KEY` | **Yes** | Tavily search engine API key | `tvly-...` |
| `PARALLEL_AI_API_KEY` | **Yes** | Parallel AI Extract primary scraper key | `pk-...` |
| `EXA_API_KEY` | **Yes** | Exa neural search & fallback scraping key | `exa-...` |
| `INTERNAL_API_KEY` | **Yes** | Secret for worker self-triggering M2M auth | Any random 32-char hex string |
| `ADMIN_EMAILS` | **Yes** | Comma-separated list of platform admin emails | `admin@bahirjee.in,ops@bahirjee.in` |
| `ALLOWED_ORIGINS` | **Yes** | Allowed CORS origins (comma-separated) | `https://bahirjee.in,https://app.bahirjee.in` |
| `KV_REST_API_URL` | Rec. | Upstash Redis REST URL for distributed rate limiting | `https://...upstash.io` |
| `KV_REST_API_TOKEN` | Rec. | Upstash Redis REST Token | `AX...` |
| `STEP_MAX_MS` | No | Max execution milliseconds per worker step | `45000` |
| `STEPPED_PIPELINE` | No | Enable stepped worker pipeline (`1` default) | `1` |
| `AUTO_ACCESS_DOMAINS` | No | Comma-separated domains granted instant access | `bahirjee.in` |
| `SITE_URL` | No | App redirect URL for magic link confirmation | `https://bahirjee.in` |

> [!WARNING]
> If `INTERNAL_API_KEY` is not set, internal worker calls fall back to `SUPABASE_SERVICE_ROLE_KEY`. Always set a distinct, strong `INTERNAL_API_KEY` in production to isolate M2M worker execution from database master privileges.

---

## 3. Supabase Database Provisioning

### 3.1 Initial Schema
1. Open the Supabase Project Dashboard -> **SQL Editor**.
2. Run the full [schema.sql](../schema.sql) script. This creates all base tables (`clients`, `profiles`, `reports`, `intelligence_jobs`, `observations`, `patterns`, `shifts`, `document_chunks`, etc.), triggers, and RLS policies.

### 3.2 Migrations Sequence
Run the sequential migration scripts located in `scripts/migrations/` in order:
- `v14_stepped_pipeline.sql` — Stepped pipeline state & observation idempotency.
- `v15_report_verification.sql` — Report verification columns & gate metadata.
- `v16_agent_runtime.sql` — Agent runtime execution tables.
- `v17_agent_runs_conflict.sql` — Upsert conflict target for agent runs.
- `v18_report_run_id_idempotency.sql` — Deduplication keys on reports.
- `v22_observation_source_types.sql` — Widened observation source types (`source_watch`, `connector`).
- `v23_parallel_ai_source_type.sql` — Support for Parallel AI scraper provenance.
- `v24_self_serve_and_run_tier.sql` — Self-serve workspaces & shallow/full run tier tracking.
- `v25_entity_categories.sql` — Expanded entity taxonomy (`customer`, `investor`, `partner`, `adjacent`).
- `v26_company_contexts.sql` — Reusable domain context store (`company_contexts`).
- `v27_company_contexts_server_write.sql` — Service-role RPC for worker context persistence.
- `v28_entity_spine.sql` — Entity canonical domains and relationship graph.
- `v29_knowledge_chunks.sql` — pgvector knowledge chunks for signals and observations.

### 3.3 Seeding Initial Data
- Run `sql/seed_admin_access.sql` to provision the initial administrator account.
  > [!IMPORTANT]
  > Change the seeded default password immediately after initial login via `/admin/reset`.
- Run `sql/seed_bahirjee_in_domain.sql` to establish the primary organization client domain.

### 3.4 Supabase Dashboard Configuration
- **Auth Settings -> URL Configuration**:
  - Site URL: `https://your-domain.com`
  - Redirect URLs: Add `https://your-domain.com/**` and `http://localhost:5173/**`
- **SMTP Settings**:
  - Configure a production SMTP provider (SendGrid, Postmark, AWS SES). The default Supabase email service is strictly rate-limited to ~3-4 emails per hour and will block magic links under production traffic.

---

## 4. Vercel Deployment Setup

### 4.1 Connecting the Repository
1. Import the repository into your Vercel team dashboard.
2. Framework Preset: **Vite**.
3. Root Directory: `./`.
4. Build Command: `npm run build` (or leave default).
5. Output Directory: `dist`.

### 4.2 Verifying `vercel.json`
Confirm your `vercel.json` matches the single-router structure:
```json
{
  "version": 2,
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "/api/router?route=$1"
    },
    {
      "source": "/((?!api/|assets/|favicon|robots|site\\.webmanifest|manifest\\.webmanifest|sw\\.js|workbox-).*)|.*\\.(?!js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2).*",
      "destination": "/index.html"
    }
  ]
}
```

### 4.3 Deploying
- Via Git: Push to `main` to trigger automated Vercel deployment.
- Via CLI:
  ```bash
  # Deploy preview
  vercel

  # Deploy production
  vercel --prod
  ```

---

## 5. Post-Deployment Smoke Tests & Verification

Run these validation checks immediately following deployment:

### 5.1 Local / Pre-Deploy Automated Checks
```bash
# Run security regression tests
npm run test:security

# Verify API router dispatch
npm run test:router

# Verify signal processing and grounding filters
npm run test:signals

# Verify production build compilation
npm run build
```

### 5.2 Live Smoke Test Checklist
1. **Admin Sign-in**:
   - Navigate to `/admin/login`.
   - Sign in with admin credentials. Confirm redirect to `/admin/clients`.
2. **Founder Intake & Context Build**:
   - Open `/` in an incognito window.
   - Enter a test target company URL.
   - Verify context extraction completes and opens the context review screen.
3. **Background Worker Execution**:
   - Confirm context and click "Run Intelligence".
   - Confirm job state updates from `pending` -> `processing` -> `completed` without browser interruptions.
4. **Shared Report View**:
   - Open `/report/:shareToken` as a non-authenticated visitor.
   - Verify identity gating and read-only brief display.
