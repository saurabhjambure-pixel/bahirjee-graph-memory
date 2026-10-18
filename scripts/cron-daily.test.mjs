/**
 * The daily ladder's guards.
 *
 * Every failure this file pins is SILENT. A daily cron that spends nothing and says nothing
 * looks exactly like a quiet morning, which is the product's normal and correct state — so
 * there is no symptom to notice and no error to read. The only defence is asserting the
 * guards directly.
 *
 * The one that already bit: a job has been sitting in `processing` in the production
 * database since 2026-09-13. A naive "is there a pending or processing job?" check would
 * make that client's loop skip every single morning, forever, logging a tidy
 * `full_run_in_progress` each time.
 *
 * Run: npm run test:cron-daily
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const handler = read('../lib/handlers/cron-daily.js')
const router = read('../api/router.js')
const jobs = read('../lib/_intelligenceJobs.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

// ─── Registration and security ──────────────────────────────────────────────

check('the route is registered in the single router, not as a new api/ file', () => {
  assert.match(router, /'cron-daily':\s*\(\)\s*=>\s*import\('\.\.\/lib\/handlers\/cron-daily\.js'\)/,
    'Vercel makes every file under api/ its own function and Hobby caps deployments at 12')
})

check('the handler applies API security before doing anything', () => {
  const body = handler.slice(handler.indexOf('export async function handler'))
  const sec = body.indexOf('applyApiSecurity')
  const work = body.indexOf('getSupabaseAdmin')
  assert.ok(sec !== -1 && sec < work, 'applyApiSecurity() must wrap the handler, before any work')
})

check('the scheduler auth chain is imported, never re-derived', () => {
  assert.match(handler, /import \{ isAuthorizedScheduler \} from '\.\/cron-runs\.js'/,
    'the engineering notes records what a mismatched copy of the INTERNAL_API_KEY precedence cost: ' +
    'every self-trigger 401d and jobs stalled in `pending`. A third copy is a third drift point.')
  assert.ok(!/const internalKey = process\.env\.INTERNAL_API_KEY/.test(handler),
    'the key precedence must not be rewritten here')
  const authAt = handler.indexOf('isAuthorizedScheduler(req)')
  const adminAt = handler.indexOf('getSupabaseAdmin()')
  assert.ok(authAt !== -1 && authAt < adminAt, 'unauthorised callers must be rejected first')
})

// ─── The guard that must age out ────────────────────────────────────────────

check('a dead job does not block the loop forever', () => {
  assert.match(handler, /isPendingJobStale|isProcessingJobStale/,
    'a job stuck in `processing` would otherwise skip that client every morning, forever, ' +
    'reporting full_run_in_progress each time — and nothing would throw')
  assert.match(handler, /\.filter\(j => !isPendingJobStale\(j\) && !isProcessingJobStale\(j\)\)/,
    'the skip must be decided on LIVE jobs only')
})

check('staleness reuses the worker\'s own thresholds rather than inventing a second answer', () => {
  assert.match(jobs, /export function isPendingJobStale/)
  assert.match(jobs, /export function isProcessingJobStale/)
  assert.ok(!/STALE_MS/.test(handler),
    'two different answers to "is this run still alive?" will drift, and the disagreement ' +
    'is invisible until a client silently stops being read')
})

// ─── Idempotency before spend ───────────────────────────────────────────────

check('today\'s check is claimed before anything is fetched or generated', () => {
  const fn = handler.slice(handler.indexOf('async function runDailyForClient'))
  const claim = fn.indexOf('todaysCheck(')
  const scrape = fn.indexOf('watchSources(')
  const llm = fn.indexOf("callLLMAction('triageDaily'")
  assert.ok(claim !== -1, 'the ledger must be consulted')
  assert.ok(claim < scrape && claim < llm,
    'a cron that fires twice — a retry, a manual trigger, a platform hiccup — must cost ' +
    'nothing the second time. Check the claim first, then do the work.')
})

check('every path records the morning, so the heartbeat can never be a guess', () => {
  const fn = handler.slice(handler.indexOf('async function runDailyForClient'))
  const records = (fn.match(/recordDailyCheck\(/g) || []).length
  assert.ok(records >= 4,
    `only ${records} recordDailyCheck call(s) — every rung that ends the morning must write ` +
    'the ledger, or the Desk says "read 19 pages" on a day it read none')
})

// ─── The two silent-inertness bugs found by a live dry-run ──────────────────

check('the runtime is pointed at the in-process dispatcher before any work', () => {
  assert.match(handler, /configureIntelligenceRuntime\(\{ postJson: internalPostJson \}\)/,
    'intelligenceRuntime.postJson DEFAULTS to the browser client and its authenticated user ' +
    'session. A cron has none, so without this every scrape and search returns "No active ' +
    'session", the ladder finds nothing every morning, and the loop is inert — while still ' +
    'writing a tidy "nothing moved". No unit test can catch it: the default IS a working function.')
  const body = handler.slice(handler.indexOf('export async function handler'))
  const wire = body.indexOf('configureIntelligenceRuntime')
  const sweep = body.indexOf("from('clients')")
  assert.ok(wire !== -1 && wire < sweep, 'it must be set before the sweep begins')
})

check('the ledger records pages READ, never pages attempted', () => {
  const fn = handler.slice(handler.indexOf('async function runDailyForClient'))
  assert.match(fn, /pagesChecked: watch\.read/,
    'watchSources.checked counts ATTEMPTS. The Desk renders it as "Bahirjee read N pages", ' +
    'so claiming an attempt as a read makes a scraper outage look like a quiet morning. ' +
    'Observed live: four failed fetches reported as four pages read.')
  assert.ok(!/pagesChecked: watch\.checked/.test(fn))
})

check('a total fetch failure is reported as an outage, not as quiet news', () => {
  const fn = handler.slice(handler.indexOf('async function runDailyForClient'))
  assert.match(fn, /watch\.read === 0 && watch\.failed > 0/,
    'nothing fetched is a problem at our end; saying "nothing moved" would be a wrong ' +
    'reassurance, which is worse than a gap')
})

check('watchSources tells a failed fetch apart from an unchanged page', () => {
  const watch = read('../src/services/sourceWatch.js')
  assert.match(watch, /return \{ observations, checked, changed: observations\.length, failed, read \}/,
    'watchSource returns null for baseline, unchanged AND failed — the three must be ' +
    'distinguishable before any of them is claimed to a founder')
  assert.match(watch, /markFailure: \(\.\.\.args\) =>/,
    'counting through the store keeps watchSource\'s return contract intact for stepWatch')
})

// ─── Spend ceilings ─────────────────────────────────────────────────────────

check('the sweep is bounded by wall clock as well as by count', () => {
  assert.match(handler, /FIRING_MAX_MS/, 'a 60s function needs a hard stop with room to persist')
  assert.match(handler, /MAX_CLIENTS_PER_FIRING/)
  assert.match(handler, /MAX_PURSUITS_PER_FIRING/)
  const ms = Number(handler.match(/FIRING_MAX_MS = (\d+)/)[1])
  assert.ok(ms < 60000, 'the stop must land before Vercel kills the function, not after')
})

check('one bad client cannot abort the sweep', () => {
  const loop = handler.slice(handler.indexOf('for (const client of clients'))
  assert.match(loop.slice(0, 1400), /catch \(clientErr\)/,
    'a single broken company must not stop every other company being read')
})

// ─── The precondition nobody set ────────────────────────────────────────────

check('the client filter is documented as a precondition, not assumed', () => {
  // Verified against production on 2026-09-15: all five clients have auto_run_cadence NULL,
  // auto_run_last_queued_at never, and zero jobs with job_origin='scheduled' have ever been
  // created. Both crons filter on this column, so BOTH are no-ops until someone sets it.
  // The filter is correct; the point of this test is that the next person reads that fact
  // here instead of rediscovering it by wondering why nothing happens.
  assert.match(handler, /auto_run_cadence/,
    'the daily loop only serves clients who opted into a cadence')
  assert.match(handler, /NOTHING RUNS UNTIL A CLIENT HAS A CADENCE/,
    'this precondition must be stated in the handler, because its failure mode is silence')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
