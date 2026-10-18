/**
 * Bahirjee's shift — the cadence the founder is shown.
 *
 * The load-bearing assertion here is the FIRST one: that `SCHEDULE` in
 * src/services/cadence.js matches the cron entry in vercel.json. Those two files cannot
 * see each other, and a mismatch does not throw — it makes Bahirjee promise a reading time
 * it does not keep, weekly, to every customer. A comment asking a future editor to keep
 * them in step is not a mechanism; this is.
 *
 * Run: npm run test:cadence
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SCHEDULE,
  CADENCE_DAYS,
  isDue,
  isActiveCadence,
  nextScheduledRead,
  describeCadence,
  relativeDays,
} from '../src/services/cadence.js'

// ── 1. the schedule the UI promises is the schedule that fires ──────────────
{
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const cron = (vercel.crons || []).find(c => String(c.path).includes('cron-runs'))
  assert.ok(cron, 'vercel.json must still schedule /api/cron-runs — the cadence bar promises it runs')

  // "minute hour day-of-month month day-of-week"
  const [minute, hour, , , dayOfWeek] = String(cron.schedule).trim().split(/\s+/)
  assert.equal(Number(hour), SCHEDULE.hourUtc,
    `vercel.json fires at hour ${hour} UTC but the UI tells founders ${SCHEDULE.hourUtc}`)
  assert.equal(Number(dayOfWeek), SCHEDULE.dayOfWeek,
    `vercel.json fires on weekday ${dayOfWeek} but the UI tells founders ${SCHEDULE.dayOfWeek}`)
  assert.equal(Number(minute), 0, 'the UI renders an on-the-hour time; a non-zero minute would make it wrong')
}
console.log('  ✓ the schedule shown to founders is the schedule vercel actually fires')

// ── 1b. the daily ladder fires daily, after the weekly synthesis ────────────
//
// The Desk's heartbeat says Bahirjee reads every morning. If this entry is missing or
// weekly, nothing throws — the app just quietly stops being a daily agent while still
// telling founders it is one. Same failure shape as the block above.
{
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const crons = vercel.crons || []
  const daily = crons.find(c => String(c.path).includes('cron-daily'))
  assert.ok(daily, 'vercel.json must schedule /api/cron-daily — the Desk promises a daily read')

  const [minute, hour, dom, month, dow] = String(daily.schedule).trim().split(/\s+/)
  assert.equal(dow, '*', 'the daily ladder must fire every day, not on one weekday')
  assert.equal(dom, '*')
  assert.equal(month, '*')
  assert.equal(Number(minute), 0)

  const weekly = crons.find(c => String(c.path).includes('cron-runs'))
  const weeklyHour = Number(String(weekly.schedule).trim().split(/\s+/)[1])
  assert.ok(Number(hour) > weeklyHour,
    'on the synthesis day both crons fire; the daily ladder must run AFTER the weekly run ' +
    'is queued, or it races it and the active-job guard simply skips the day')

  // Vercel Hobby allows at most two cron entries, each at most once per day. A third
  // would not fail a test — it would fail the deploy, after the work was done.
  assert.ok(crons.length <= 2,
    `${crons.length} cron entries — Hobby caps this at 2. Fold the new schedule into an ` +
    'existing handler rather than adding an entry.')
}
console.log('  ✓ the daily ladder fires daily, after the weekly synthesis, within the Hobby cap')

// ── 1c. setting the cadence ─────────────────────────────────────────────────
//
// `auto_run_cadence` was readable from v18 and settable by nobody, which is the whole
// reason nothing scheduled has ever run. The control added in v35 has two failure modes
// that are silent, and both are pinned here.
{
  const service = readFileSync(new URL('../src/services/cadenceService.js', import.meta.url), 'utf8')
  const rpc = readFileSync(new URL('./migrations/v35_set_client_cadence.sql', import.meta.url), 'utf8')
  const v18 = readFileSync(new URL('./migrations/v18_client_auto_run.sql', import.meta.url), 'utf8')

  // (a) THREE places name the allowed values: the v18 CHECK, the v35 RPC's own validation,
  //     and the picker. A picker offering a value Postgres rejects fails at the last step,
  //     after the founder has already been told it worked.
  const offered = [...service.matchAll(/value: '([a-z]+)'/g)].map(m => m[1])
  const fromDays = [...service.matchAll(/CADENCE_DAYS/g)].length
  assert.ok(fromDays > 0, 'the picker must derive its options from CADENCE_DAYS, not retype them')
  const rpcValues = rpc.match(/NOT IN \(([^)]*)\)/)[1].split(',').map(x => x.trim().replace(/'/g, ''))
  const checkValues = v18.match(/in \(([^)]*)\)/i)[1].split(',').map(x => x.trim().replace(/'/g, ''))
  for (const v of [...Object.keys(CADENCE_DAYS), 'off']) {
    assert.ok(rpcValues.includes(v), `v35 rejects "${v}" but the UI can offer it`)
    assert.ok(checkValues.includes(v), `the v18 CHECK rejects "${v}" but the UI can offer it`)
  }
  for (const v of offered) {
    assert.ok(checkValues.includes(v), `the picker offers "${v}", which the v18 CHECK rejects`)
  }

  // (b) A plain UPDATE would match ZERO rows — RLS on `clients` grants non-admins SELECT
  //     only — and Supabase returns success with empty data. Silent no-op.
  assert.match(service, /supabase\.rpc\('set_client_cadence'/,
    'the write must go through the RPC; a direct .update() on clients is a silent no-op for ' +
    'every non-admin, because there is no UPDATE policy on that table')
  assert.ok(!/from\('clients'\)[\s\S]{0,200}\.update\(/.test(service))

  // (c) Enabling a cadence spends money weekly, and scheduled runs deliberately bypass the
  //     freemium quota (cron-runs passes reservedRun:false) — so a free account on weekly
  //     would get ~52 full runs a year unbilled. The gate must be server-side.
  assert.match(rpc, /is_premium|exempt_from_freemium/,
    'entitlement must be decided in the RPC, where the client cannot reach it — the same ' +
    'rule as run tier, which is never read from a request body')
  assert.match(rpc, /COALESCE\(p_cadence, 'off'\) <> 'off'/,
    'turning a cadence OFF must always be allowed: a paywall that traps someone into ' +
    'spending is a subscription trap')
  assert.match(rpc, /SECURITY DEFINER/)

  // (d) An unapplied v35 must say so, not read as a permissions problem.
  assert.match(service, /42883/,
    'the migration window is exactly when this code is most likely to run un-migrated')
}
console.log('  ✓ the cadence can be set, by exactly the people entitled to set it')

// ── 2. what counts as watching ──────────────────────────────────────────────
{
  assert.equal(isActiveCadence('weekly'), true)
  assert.equal(isActiveCadence('monthly'), true)
  assert.equal(isActiveCadence('off'), false)
  assert.equal(isActiveCadence(null), false, 'NULL is the default for every existing client and must mean "not watching"')
  assert.equal(isActiveCadence('daily'), false, 'a cadence the CHECK constraint forbids must not be treated as active')
  assert.deepEqual(Object.keys(CADENCE_DAYS).sort(), ['monthly', 'weekly'], 'adding a cadence needs the DB CHECK in v18 widened too')
}
console.log('  ✓ only a real cadence counts as watching')

// ── 3. due-ness, unchanged from the scheduler's own rules ───────────────────
{
  const now = Date.parse('2026-09-09T10:00:00Z')
  assert.equal(isDue({ auto_run_cadence: 'weekly' }, now), true, 'never queued is due immediately')
  assert.equal(isDue({ auto_run_cadence: 'off', auto_run_last_queued_at: null }, now), false)
  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: '2026-09-08T06:00:00Z' }, now), false, 'queued yesterday is not due')
  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: '2026-09-01T06:00:00Z' }, now), true, 'queued 8 days ago is due')
  assert.equal(isDue({ auto_run_cadence: 'weekly', auto_run_last_queued_at: 'not-a-date' }, now), true, 'an unparseable timestamp must not strand a client forever')
}
console.log('  ✓ due-ness matches the scheduler')

// ── 4. the next read is a tick, not a due date ──────────────────────────────
{
  // Wednesday. A run that becomes due today is not read today — the scheduler only fires
  // on its tick. Promising the due date would name a day no read can happen on.
  const wed = new Date('2026-09-09T10:00:00Z')
  assert.equal(wed.getUTCDay(), 3, 'fixture sanity: this is a Wednesday')

  const next = nextScheduledRead({ auto_run_cadence: 'weekly', auto_run_last_queued_at: '2026-09-07T06:00:00Z' }, wed)
  assert.equal(next.toISOString(), '2026-09-14T06:00:00.000Z', 'weekly from last Monday lands on the next Monday tick')
  assert.equal(next.getUTCDay(), SCHEDULE.dayOfWeek, 'every predicted read must fall on a day the scheduler fires')

  const overdue = nextScheduledRead({ auto_run_cadence: 'weekly', auto_run_last_queued_at: '2026-08-01T06:00:00Z' }, wed)
  assert.ok(overdue > wed, 'an overdue client is still read at the next tick, never in the past')
  assert.equal(overdue.toISOString(), '2026-09-14T06:00:00.000Z')

  // Monthly becomes due 1 Oct (a Thursday); the first tick on or after is Monday 5 Oct.
  const monthly = nextScheduledRead({ auto_run_cadence: 'monthly', auto_run_last_queued_at: '2026-09-01T06:00:00Z' }, wed)
  assert.equal(monthly.toISOString(), '2026-10-05T06:00:00.000Z', 'a due date mid-week waits for the tick')
  assert.equal(monthly.getUTCDay(), SCHEDULE.dayOfWeek)

  assert.equal(nextScheduledRead({ auto_run_cadence: 'off' }, wed), null, 'not watching means no promised read')
  assert.equal(nextScheduledRead({}, wed), null)

  // On the firing day itself, before and after the hour.
  const monEarly = new Date('2026-09-14T05:00:00Z')
  assert.equal(nextScheduledRead({ auto_run_cadence: 'weekly' }, monEarly).toISOString(), '2026-09-14T06:00:00.000Z', 'before the hour, today still counts')
  const monLate = new Date('2026-09-14T07:00:00Z')
  assert.equal(nextScheduledRead({ auto_run_cadence: 'weekly' }, monLate).toISOString(), '2026-09-21T06:00:00.000Z', 'after the hour, the next tick is next week')
}
console.log('  ✓ the promised read always falls on a day the scheduler fires')

// ── 5. how the shift is described ───────────────────────────────────────────
{
  // Chrome speaks about Bahirjee in the third person; Bahirjee speaks in the first.
  assert.equal(describeCadence('weekly'), 'Reads every Monday')
  assert.ok(!/^I /.test(describeCadence('weekly')), 'chrome describes Bahirjee, it does not speak as Bahirjee')
  assert.equal(describeCadence(null), 'Not watching yet')

  const now = new Date('2026-09-09T10:00:00Z')
  assert.equal(relativeDays(new Date('2026-09-09T01:00:00Z'), now), 'today')
  assert.equal(relativeDays(new Date('2026-09-08T06:00:00Z'), now), 'yesterday')
  assert.equal(relativeDays(new Date('2026-09-10T06:00:00Z'), now), 'tomorrow')
  assert.equal(relativeDays(new Date('2026-09-07T06:00:00Z'), now), '2 days ago')
  assert.equal(relativeDays(new Date('2026-09-14T06:00:00Z'), now), 'in 5 days')
  assert.equal(relativeDays(null, now), null, 'a client that has never been read shows nothing, not "55 years ago"')
  assert.equal(relativeDays('not-a-date', now), null)
}
console.log('  ✓ the shift is described the way a person would say it')

console.log('cadence tests passed')
