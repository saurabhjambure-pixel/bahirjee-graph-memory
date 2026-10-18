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
| `SUPABASE_ANON_KEY` | No | Supabase anon key for `auth-link`; falls back to `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOi...` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service-role secret key | `eyJhbGciOi...` |
| `GEMINI_API_KEY` | **Yes** | Google AI Studio Gemini API Key | `AIzaSy...` |
| `TAVILY_API_KEY` | **Yes** | Tavily search engine API key | `tvly-...` |
| `PARALLEL_AI_API_KEY` | **Yes** | Parallel AI Extract primary scraper key | `pk-...` |
| `EXA_API_KEY` | **Yes** | Exa neural search & fallback scraping key | `exa-...` |
| `INTERNAL_API_KEY` | **Yes** | Secret for worker self-triggering M2M auth | Any random 32-char hex string |
| `LOGIN_EMAIL` | No | The ONE email allowed to sign in (instantly, no password). Every other email is refused. | `admin@bahirjee.in` (default) |
| `CRON_SECRET` | **Yes** | Vercel sends it as `Authorization: Bearer …` on the two crons in `vercel.json` only when it is set, so without it every scheduled run gets 401 | Any random 32+ char string |
| `ALLOWED_ORIGINS` | No | EXTRA CORS origins only — the deployment's own origin is trusted automatically | `https://bahirjee.in,https://app.bahirjee.in` |
| `MEMORY_GRAPH_ENABLED` | No | `1` turns on the FalkorDB memory graph; anything else = degraded mode | `1` |
| `FALKORDB_URL` / `FALKORDB_USERNAME` / `FALKORDB_PASSWORD` | With graph | FalkorDB Cloud instance (free tier = `falkor://`, paid TLS = `falkors://`) | `falkor://host.r1.falkordb.io:PORT` |
| `KV_REST_API_URL` | Rec. | Upstash Redis REST URL for distributed rate limiting | `https://...upstash.io` |
| `KV_REST_API_TOKEN` | Rec. | Upstash Redis REST Token | `AX...` |
| `STEP_MAX_MS` | No | Max execution milliseconds per worker step | `45000` |
| `STEPPED_PIPELINE` | No | Enable stepped worker pipeline (`1` default) | `1` |
| `SITE_URL` | No | App redirect URL for magic link confirmation | `https://bahirjee.in` |

> [!WARNING]
> If `INTERNAL_API_KEY` is not set, internal worker calls fall back to `SUPABASE_SERVICE_ROLE_KEY`. Always set a distinct, strong `INTERNAL_API_KEY` in production to isolate M2M worker execution from database master privileges.

---

## 3. Supabase Database Provisioning

### 3.1 Fresh project — apply order
`schema.sql` alone does **not** produce a working database. A fresh project needs the base
schema, every migration, and `sql/context_signals_schema.sql` (which must come after the v6
migrations because it references `observations`). This exact order was dry-run end to end
against an empty Postgres 16 with Supabase's `auth` schema and roles stubbed:

1. `schema.sql`
2. `scripts/migrations/v6_phase1_observations.sql`, `v6_phase2_patterns.sql`, `v6_phase3_shifts.sql`, `v6_phase4_blindspots_opportunities.sql`, `v6_phase7_impact.sql`
3. `sql/context_signals_schema.sql`
4. `scripts/migrations/v7_*` through `v38_*` in numeric order. Where two files share a number, either order works: `v8_company_memory` then `v8_company_memory_backfill`; both `v15_*`; both `v16_*`; both `v17_*`; both `v18_*`.
5. Seed: `sql/seed_bahirjee_in_domain.sql`. Never run `sql/seed_dev_bypass_user.sql` in production.

Every file is idempotent. `v37_intelligence_targets.sql` carries its own `BEGIN; … COMMIT;` — paste it whole.

Pasting 45 files into the SQL editor is error-prone; with the project's **direct** connection
string (Project Settings → Database → Connection string → URI) the same order runs in one go:

```bash
export SUPABASE_DB_URL='postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres'
M=scripts/migrations
for f in schema.sql $M/v6_*.sql sql/context_signals_schema.sql \
         $(ls $M/v*.sql | grep -v '/v6_' | sort -t v -k2 -n) \
         sql/seed_bahirjee_in_domain.sql; do
  echo "== $f"; psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" || break
done
```

### 3.2 Seeding notes
- `sql/seed_bahirjee_in_domain.sql` creates the `bahirjee.in` client. The sign-in account (`LOGIN_EMAIL`) is created on its first sign-in and attached to this client as a full member; there is no admin account.

### 3.3 Verify
```sql
select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';  -- 39
select 1 from public.intelligence_targets limit 1;                             -- no error = v37 applied
select domain from public.clients where domain = 'bahirjee.in';               -- the sign-in workspace
```

### 3.4 Supabase Dashboard Configuration
- No email or SMTP setup is needed for sign-in: `/api/auth-link` mints a sign-in token server-side and the browser verifies it directly, so no email is sent.
- **Auth → URL Configuration**: set Site URL to the production domain (only used by Supabase's own emails, which this flow never triggers).

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
# Verify API router dispatch
npm run test:router

# Verify the memory graph layer
npm run test:graph

# Verify production build compilation
npm run build
```

### 5.2 Live Smoke Test Checklist
1. **Sign-in**:
   - On `/`, enter `admin@bahirjee.in` (or your `LOGIN_EMAIL`). Confirm you land in the app with no email step.
   - Enter any other email. Confirm "This email doesn't have access." 
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
