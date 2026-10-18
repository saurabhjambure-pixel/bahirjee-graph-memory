# Bahirjee Platform — Troubleshooting Guide

This guide covers failure modes, diagnosis procedures, and resolutions for common operational issues across the Bahirjee Intelligence Platform.

---

## 1. Intelligence Pipeline & Background Worker

### Issue 1.1: Intelligence Job Stuck in `pending`
- **Symptom**: A submitted report analysis never advances past `pending` or the progress bar remains frozen at 0%.
- **Root Causes**:
  1. `INTERNAL_API_KEY` mismatch: The worker endpoint (`/api/intelligence-worker`) rejects self-triggering requests with HTTP 401.
  2. The serverless invocation failed to dispatch the asynchronous background trigger.
- **Resolution**:
  - In your server environment variables, ensure `INTERNAL_API_KEY` is set and identical in both caller and receiver contexts.
  - Note: If `INTERNAL_API_KEY` is unset, the system falls back to `SUPABASE_SERVICE_ROLE_KEY`. If one environment has `INTERNAL_API_KEY` and another relies on the fallback, self-triggers will fail.
  - Check Vercel function logs for `/api/intelligence-worker` to see the exact rejection reason.

### Issue 1.2: Job Execution Times Out Mid-Run
- **Symptom**: Analysis progresses through context and queries, then abruptly fails or stalls without creating a report.
- **Root Causes**:
  - Vercel function timeout exceeded. On Hobby/Pro plans, functions have a 15s to 60s max execution limit.
  - `STEPPED_PIPELINE` disabled: When running as a single invocation monolith (`STEPPED_PIPELINE=0`), a full run (~2-3 minutes) exceeds Vercel limits.
- **Resolution**:
  - Ensure `STEPPED_PIPELINE=1` (the default) so the worker checkpoints state to Postgres after each phase and re-triggers itself.
  - Verify `STEP_MAX_MS` is set to at least `45000` (45 seconds), which provides enough budget for the longest individual step (Gemini analysis batches).

### Issue 1.3: Worker Fails to Save Company Context
- **Symptom**: Worker logs show `"function set_current_company_context_service does not exist"` or `PGRST204`.
- **Root Cause**: Database migration `v27_company_contexts_server_write.sql` has not been applied to Supabase.
- **Resolution**:
  - Execute `scripts/migrations/v27_company_contexts_server_write.sql` in the Supabase SQL editor. This installs the service-role RPC that allows worker sessions (which lack `auth.uid()`) to persist verified company context.

---

## 2. Scraping & Search Failures

### Issue 2.1: Target Website Context Building Returns Minimal Data
- **Symptom**: Inferred context during onboarding is sparse, misses competitors, or shows low confidence.
- **Root Causes**:
  - Primary scraper (`Parallel AI Extract`) failed due to anti-bot protection, IP blocking, or depleted API credits.
  - Target site uses heavy client-side JavaScript rendering without prerendering.
- **Resolution**:
  - The system automatically falls back to `Exa` when Parallel AI extraction yields fewer than 500 characters. Verify that `EXA_API_KEY` is valid and active in your environment.
  - Test scraping manually via curl against `/api/scrape`:
    ```bash
    curl -X POST https://your-domain.com/api/scrape \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer <JWT>" \
      -d '{"url": "https://example.com"}'
    ```

### Issue 2.2: Search Queries Return No Results
- **Symptom**: Pipeline search stage logs `0 observations gathered` across queries.
- **Root Cause**: Tavily API key exhausted, invalid, or blocked.
- **Resolution**:
  - Check the Tavily developer dashboard for rate limits or monthly quota depletion.
  - Test `/api/search` directly to confirm query responses.

---

## 3. Signal Filtering & Verification Drops

### Issue 3.1: Few or Zero Signals in Generated Report
- **Symptom**: Pipeline completes successfully, but the final report contains very few signals despite extensive raw source text.
- **Root Causes**:
  1. **Grounding Guard Drop**: `filterGroundedSignals()` automatically discards any signal whose cited `source_url` was not in the exact batch of source text sent to the LLM.
  2. **Quote-Binding Filter Enabled**: If `VITE_SIGNAL_QUOTE_BINDING=true`, signals from the web are discarded if the LLM cannot extract a verbatim quote present in the source text.
- **Resolution**:
  - Ensure `VITE_SIGNAL_QUOTE_BINDING` is set to `false` (default) in production. Quote-binding should only be enabled in staging environments with controlled datasets.
  - Inspect report verification metrics (`citation_precision`) in Supabase `reports.metadata` to identify which filter rejected signals.

### Issue 3.2: Uploaded Pitch Deck Contributes No Competitors
- **Symptom**: Founder uploads a PDF pitch deck, but none of the competitors mentioned in the deck appear in the context review or watchlist.
- **Root Cause**:
  - **Quote-or-drop verification**: `documentIntelService.js` strictly requires every extracted entity to be accompanied by a verbatim quote or exact name match in the document text. Scanned or image-only pages that yield no raw text will fail this check.
- **Resolution**:
  - Ensure `Claude Haiku` vision recovery is active in `lib/_vision.js` to transcribe scanned PDF pages.
  - Confirm that `mammoth` and `pdf-parse` dependencies parse the document correctly via `/api/upload`.

---

## 4. Authentication & Access Control

### Issue 4.1: Admin Cannot Log In via Magic Link
- **Symptom**: Entering an admin email address on the main login screen does not send an email and displays a redirect message.
- **Root Cause**: **Intended Security Design**. Admins are explicitly barred from the magic-link flow to prevent privilege escalation or accidental bootstrap bypass.
- **Resolution**:
  - Admins must authenticate using their email and password at `/admin/login`.

### Issue 4.2: Magic Link Not Received by Users
- **Symptom**: User enters their email, the app indicates an email was sent, but no email arrives.
- **Root Causes**:
  - Supabase built-in SMTP quota exceeded (default is ~3–4 emails/hour).
  - Domain is not listed on an active client record, causing `/api/auth-link` to return `{ noAccess: true }`.
- **Resolution**:
  - Check the Supabase Auth logs.
  - Configure a custom SMTP provider (SendGrid, Postmark, AWS SES) in Supabase.
  - Verify that the user's email domain matches an active client in `public.clients` or is present in `public.email_allowlist`.

### Issue 4.3: "Database Error Querying Schema" on Password Login
- **Symptom**: Admin password sign-in fails with an opaque Postgres schema error.
- **Root Cause**: Hand-inserted rows into `auth.users` often leave GoTrue's confirmation and token columns as `NULL`.
- **Resolution**:
  - Run `sql/seed_admin_access.sql`, which normalizes token columns to `''` as required by Supabase Auth GoTrue service.

---

## 5. Database Schema & Migration Conflicts

### Issue 5.1: `PGRST204` Column Not Found Errors
- **Symptom**: API calls return HTTP 400 with message `"Could not find the 'xyz' column of 'table' in the schema cache"`.
- **Resolution**:
  - Compare your database state against the migration files in `scripts/migrations/`:
    - Missing `canonical_domain` or `entity_id`: Apply `v28_entity_spine.sql`.
    - Missing `kind` or `source_url` on `document_chunks`: Apply `v29_knowledge_chunks.sql`.
    - Missing `run_tier` on `reports`: Apply `v24_self_serve_and_run_tier.sql`.
  - Reload the PostgREST schema cache in the Supabase Dashboard: **Project Settings -> API -> Reload schema cache**.

### Issue 5.2: Observation Insertion Rejection (SQLSTATE 23514)
- **Symptom**: Worker logs show CHECK constraint violation on `observations.source_type`.
- **Root Cause**: `observations.source_type` had a restrictive CHECK constraint that rejected `source_watch` and `connector` source types.
- **Resolution**:
  - Run `scripts/migrations/v22_observation_source_types.sql` to widen the allowed values.

---

## 6. Vercel Serverless & Routing

### Issue 6.1: API Endpoints Return 404
- **Symptom**: Requests to `/api/search`, `/api/gemini`, etc., return 404 Not Found.
- **Root Causes**:
  - Missing rewrite rule in `vercel.json`.
  - Handler was added to `lib/handlers/` but omitted from the dispatcher dictionary in `api/router.js`.
- **Resolution**:
  - Verify `vercel.json` routes `/api/(.*)` to `/api/router?route=$1`.
  - Verify `api/router.js` imports the handler in `const handlers = { ... }`.
  - Run the router verification test: `npm run test:router`.

### Issue 6.2: File Upload Fails with 413 or Empty Body
- **Symptom**: Uploading documents via `/api/upload` fails or returns empty metadata.
- **Root Cause**: Vercel's default JSON body parser consumed the multipart stream before Busboy could read it.
- **Resolution**:
  - `api/router.js` explicitly disables the Vercel body parser (`config.api.bodyParser = false`) and uses custom non-destructive body parsing. Never enable body parsing on the router level.