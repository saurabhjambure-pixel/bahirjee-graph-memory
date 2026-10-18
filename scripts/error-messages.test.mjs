/**
 * Founder-facing error copy — nothing internal may reach the error screen as the headline.
 *
 * The trigger: a real ezobooks.in run ended with this on a founder's screen, verbatim —
 *
 *   "Refusing to persist: no verification verdict for this run. The `verify` step must run
 *    before `persist` (set VERIFIER_MODE=off to publish without the gate deliberately)."
 *
 * — a pipeline step name, an internal invariant, and an env var they were being told to set.
 * getFriendlyError() rewrote raw Postgres errors but passed anything hand-authored straight
 * through, and every error this pipeline throws is hand-authored. It was written for us.
 *
 * The corpus below is not invented: each string is (or closely mirrors) a real `throw` in
 * src/services and lib/. That is the point of this file — the passthrough is still the last
 * resort in getFriendlyError(), so the guard against a NEW leak is this corpus growing when
 * a new throw site is added. If you add an internal throw whose text could reach the UI, add
 * it here.
 *
 * Run: npm run test:errors
 */
import assert from 'node:assert/strict'

import { getFriendlyError } from '../src/utils/errorMessages.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn(); passed++; console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1
  }
}

console.log('\nfounder-facing error copy')

// ── the message that started this ─────────────────────────────────────────────

check('the verifier refusal never reaches a founder verbatim', () => {
  const raw = 'Refusing to persist: no verification verdict for this run. The `verify` step must run '
    + 'before `persist` (set VERIFIER_MODE=off to publish without the gate deliberately).'
  const { friendly, technical } = getFriendlyError(raw)

  assert.notEqual(friendly, raw, 'the raw invariant must not be the headline')
  assert.doesNotMatch(friendly, /VERIFIER_MODE|`|persist\b|verdict/i,
    'no env var, no backticked step name, no internal vocabulary')
  assert.match(friendly, /nothing was saved/i,
    'a founder must be told the outcome — that the run produced nothing — not the mechanism')
  assert.equal(technical, raw, 'the raw text must survive for the console and the details panel')
})

// ── the rest of the corpus ────────────────────────────────────────────────────

const INTERNAL_THROWS = [
  'Rate limit circuit breaker open for "analyzeSignals". Too many consecutive 429 errors. Wait 60s.',
  'Rate limit circuit breaker tripped for "generateSummary". Stopping retries.',
  'Unknown pipeline step: verify',
  'Pipeline exceeded 8 invocations at step "analyze" — aborting to avoid a re-trigger loop.',
  'Step "analyze" deferred without making progress (cursor 12) — aborting to avoid a re-trigger loop.',
  'No internal handler registered for /api/gemini',
  'Supabase admin env not configured. Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
  'Claude auth error: invalid x-api-key',
  'Exa search 401: unauthorized',
  'Gemini API: Time budget exhausted after 2 retries. Elapsed: 45000ms',
  'Gemini 429 on gemini-2.5-pro: quota exceeded (exhausted 2 retries)',
  'Gemini Error 503: Unknown Error',
  'Empty Gemini response. No diagnostics available.',
  'Failed to parse LLM response: Unexpected token }. Preview: {"signals":[{"signal_headline"...',
  'Embedding failed (500)',
  'Analysis finished but no persisted report ID was returned.',
]

const GENERIC = 'Something unexpected happened on our end. Please retry — if this keeps happening, contact support.'

check('no internal throw reaches the founder as the headline', () => {
  for (const raw of INTERNAL_THROWS) {
    const { friendly, technical } = getFriendlyError(raw)
    assert.notEqual(friendly, raw, `leaked verbatim: ${raw}`)
    assert.equal(technical, raw, `technical text was dropped instead of tucked away: ${raw}`)
  }
})

check('uncaught JS exceptions are never shown raw', () => {
  // These arrive through ErrorBoundary, which passes error.message straight in.
  for (const raw of [
    "TypeError: Cannot read properties of undefined (reading 'signals')",
    'ReferenceError: buildReportData is not defined',
    'state.analyze.signals.map is not a function',
  ]) {
    const { friendly, technical } = getFriendlyError(raw)
    assert.equal(friendly, GENERIC, `leaked a stack-adjacent message: ${raw}`)
    assert.equal(technical, raw)
  }
})

// ── and the copy that IS for founders must survive untouched ──────────────────
//
// The counterweight. A guard that rewrote everything would be trivially "safe" and would
// destroy the deliberate, situation-specific messages the product already writes.

check('messages written for founders pass through unchanged', () => {
  for (const raw of [
    'Your analysis finished and the brief was saved, but it could not be opened with this account. '
      + 'Sign in again to view it — the brief is safe in your history.',
    'Lost connection to the analysis service. Your report may still be processing — reload the page to reconnect.',
    'Could not save your name. Please try again.',
    'You have reached your free report limit. Upgrade to run more.',
    'Analysis failed.',
  ]) {
    const { friendly, technical } = getFriendlyError(raw)
    assert.equal(friendly, raw, `rewrote a message that was already for founders: ${raw}`)
    assert.equal(technical, null, 'founder-facing copy is not a technical detail')
  }
})

// ── the original Postgres rules must still hold ───────────────────────────────

check('raw database errors are still rewritten', () => {
  const fk = getFriendlyError('insert or update on table "reports" violates foreign key constraint "reports_client_id_fkey"')
  assert.match(fk.friendly, /organization/i)
  assert.doesNotMatch(fk.friendly, /constraint|fkey/i, 'constraint names are an info leak')

  const rls = getFriendlyError('new row violates row-level security policy for table "reports"')
  assert.match(rls.friendly, /permission/i)

  const jwt = getFriendlyError('JWT expired')
  assert.match(jwt.friendly, /sign in again/i)
})

check('empty input yields a safe default', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const { friendly, technical } = getFriendlyError(raw)
    assert.match(friendly, /something went wrong/i)
    assert.equal(technical, null)
  }
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
