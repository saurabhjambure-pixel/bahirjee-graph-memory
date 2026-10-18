/**
 * Scheduled-runs guards.
 *
 * This route spends real money on a timer, so the tests that matter are the ones that
 * stop it running: authentication, and whether a cadence is actually due.
 *
 * Run: npm run test:cron
 */
import assert from 'node:assert/strict'
import { handler, isDue } from '../lib/handlers/cron-runs.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/handlers/cron-runs.js', import.meta.url)), 'utf8')

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-07-29T06:00:00Z')

// ── Cadence: opt-in only ────────────────────────────────────────────────────────
{
  // Anything without an explicit cadence must never auto-run — this is the guard that
  // keeps a client from being billed for something they did not ask for.
  assert.equal(isDue({}, now), false, 'no cadence = never due')
  assert.equal(isDue({ auto_run_cadence: null }, now), false, 'null cadence = never due')
  assert.equal(isDue({ auto_run_cadence: 'off' }, now), false, '"off" = never due')
  assert.equal(isDue({ auto_run_cadence: 'nonsense' }, now), false, 'unknown cadence = never due')

  // Opted in but never queued: due immediately.
  assert.equal(isDue({ auto_run_cadence: 'weekly' }, now), true, 'never queued = due now')
  assert.equal(
    isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: 'not-a-date' }, now),
    true,
    'unparseable timestamp falls back to due'
  )
}

// ── Cadence: interval boundaries ────────────────────────────────────────────────
{
  const at = (ms) => new Date(now - ms).toISOString()

  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: at(6 * DAY) }, now), false,
    'weekly at 6 days = not yet due')
  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: at(7 * DAY) }, now), true,
    'weekly at exactly 7 days = due')
  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: at(30 * DAY) }, now), true,
    'weekly long overdue = due')

  assert.equal(isDue({ auto_run_cadence: 'monthly', auto_run_last_queued_at: at(29 * DAY) }, now), false,
    'monthly at 29 days = not yet due')
  assert.equal(isDue({ auto_run_cadence: 'monthly', auto_run_last_queued_at: at(30 * DAY) }, now), true,
    'monthly at exactly 30 days = due')
}

// ── Authentication ──────────────────────────────────────────────────────────────
{
  const call = async (headers) => {
    let status = 200
    let payload = null
    const res = {
      setHeader() {}, status(c) { status = c; return this },
      json(p) { payload = p; return this }, end() { return this },
    }
    await handler({ method: 'GET', headers, body: {} }, res)
    return { status, payload }
  }

  // Isolate from whatever the developer's .env holds.
  const saved = { ...process.env }
  process.env.INTERNAL_API_KEY = 'test-internal-key'
  process.env.CRON_SECRET = 'test-cron-secret'
  delete process.env.SUPABASE_URL
  delete process.env.VITE_SUPABASE_URL

  const anonymous = await call({})
  assert.equal(anonymous.status, 401, 'no credentials = 401')

  const wrongKey = await call({ 'x-bahirjee-internal-key': 'nope' })
  assert.equal(wrongKey.status, 401, 'wrong internal key = 401')

  const wrongBearer = await call({ authorization: 'Bearer nope' })
  assert.equal(wrongBearer.status, 401, 'wrong bearer = 401')

  // Correct credentials must get PAST auth. Supabase config is stripped above, so the
  // handler should fail at client construction (500) rather than be rejected as 401 —
  // that difference is exactly what proves authentication succeeded.
  const withInternal = await call({ 'x-bahirjee-internal-key': 'test-internal-key' })
  assert.notEqual(withInternal.status, 401, 'valid internal key passes auth')

  const withCron = await call({ authorization: 'Bearer test-cron-secret' })
  assert.notEqual(withCron.status, 401, 'valid Vercel cron bearer passes auth')

  process.env = saved
}


// ── Which context a scheduled run replays ───────────────────────────────────────
//
// A weekly run that replays lastReport.context replays a run OUTPUT: already mutated by
// stepDiscoverCompetitors, stepValidateExa and stepMemory's competitor merge, and carrying
// none of the founder's review-screen corrections. Compounded weekly, a competitor the
// founder deleted comes back forever and nobody is ever told. company_contexts holds what
// they actually approved.
{
  assert.match(
    SOURCE, /from\('company_contexts'\)/,
    'a scheduled run must prefer the founder-approved context over the last report'
  )
  assert.match(SOURCE, /\.eq\('is_current', true\)/, 'it must read the current version, not any version')
  assert.match(SOURCE, /\.eq\('client_id', client\.id\)/, 'the lookup must stay tenant-scoped')
  assert.match(SOURCE, /\.eq\('target_domain', targetDomain\)/, 'the lookup is keyed on domain')

  // The fallback is what keeps every existing client running on the day v26 ships.
  assert.match(
    SOURCE, /let contextPayload = lastReport\.context/,
    'lastReport.context must remain the fallback — a client with no stored context yet must ' +
    'still get its scheduled run, not be skipped'
  )
  assert.match(
    SOURCE, /42P01/,
    'a database without v26 applied must fall through to the last report rather than throw ' +
    'and abort the sweep for that client'
  )

  // no_prior_report stays the outer guard: a client with a stored context but no report has
  // no website_url to run against.
  assert.match(SOURCE, /reason: 'no_prior_report'/, 'the no-report skip must survive')

  // A scheduled run is never a decision run.
  assert.match(
    SOURCE, /delete contextPayload\._decision/,
    'a stored decision frame must be stripped before it reaches contextPayload, or the ' +
    'weekly run emits a decision brief against a question nobody is asking'
  )
  // ...and stripped on a COPY, or the delete mutates the row we just read.
  assert.match(
    SOURCE, /contextPayload = \{ \.\.\.contextPayload \}/,
    '_decision must be stripped from a clone'
  )

  assert.ok(
    !/contextPayload: lastReport\.context/.test(SOURCE),
    'the job must be created with the resolved contextPayload, not lastReport.context — ' +
    'resolving the right context and then sending the wrong one is the same bug with extra steps'
  )
}

console.log('cron runs tests passed')
