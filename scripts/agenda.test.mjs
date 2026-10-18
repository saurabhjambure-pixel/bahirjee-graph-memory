/**
 * The Agenda — round-trip and anti-rot tests.
 *
 * open_questions has the exact shape that has cost this codebase real evidence twice:
 * a table with more than one writer (the browser and the worker), a row mapper, and CHECK
 * constraints the code can outgrow — where every failure mode is silent.
 *
 *   • observation-roundtrip: a column missing from a `.select()` read back as undefined,
 *     and `attachSourceClass` returned early on every batch for months.
 *   • v25_entity_categories: a CHECK frozen at five values while the code emitted eight;
 *     Postgres rejected every row and `storeEntityWatchlist` counted the error and
 *     returned normally, so uploaded decks contributed nothing to the watchlist.
 *
 * Plus one failure mode this table invents, which nothing else in the codebase guards:
 *
 *   • A weekly run regenerates near-identical falsifiers. If `openQuestion` blind-upserts,
 *     a question the founder retired is back within seven days and the retire control is
 *     decorative. Nothing throws; the Agenda just refuses to shrink. tracked_entities has
 *     exactly this disease today — `is_active` is only ever written TRUE and no path can
 *     retire a row.
 *
 * Run: npm run test:agenda
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  AGENDA_ORIGINS,
  AGENDA_STATUSES,
  AGENDA_SENSITIVITIES,
  AGENDA_COLUMNS,
  IRRELEVANT_STRIKES_TO_RETIRE,
  questionKey,
  computePriority,
  rankAgenda,
  harvestQuestions,
} from '../src/services/agendaService.js'
import { CONTRADICTION_WATCH_FOR } from '../src/services/briefSchema.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const service = read('../src/services/agendaService.js')
const migration = read('./migrations/v34_agenda.sql')
/** The migration with `--` comments stripped, for assertions about actual DDL. The header
 *  explains at length why there is no SECURITY DEFINER here, and prose must not satisfy —
 *  or contradict — a structural check. */
const migrationDDL = migration.replace(/--[^\n]*/g, '')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

function functionBody(source, name) {
  const start = source.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`))
  assert.notEqual(start, -1, `${name} not found — this test is pinned to it`)
  const paramOpen = source.indexOf('(', start)
  let parens = 0
  let afterParams = -1
  for (let i = paramOpen; i < source.length; i++) {
    if (source[i] === '(') parens++
    else if (source[i] === ')' && --parens === 0) { afterParams = i + 1; break }
  }
  assert.notEqual(afterParams, -1, `unbalanced parens in ${name}`)
  const open = source.indexOf('{', afterParams)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

/** Pull the value list out of `CHECK (col IN ('a', 'b'))` in the migration. */
function checkValues(column) {
  const m = migration.match(new RegExp(`CHECK\\s*\\(\\s*${column}[^)]*IN\\s*\\(([^)]*)\\)`, 'i'))
  assert.ok(m, `no CHECK constraint found for ${column} in v34_agenda.sql`)
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-14T06:00:00Z')
const item = (over = {}) => ({
  status: 'open',
  origin: 'falsifier',
  sensitivity: 'medium',
  useful_count: 0,
  irrelevant_count: 0,
  pinned: false,
  opened_at: new Date(NOW - 2 * DAY).toISOString(),
  last_checked_at: null,
  last_moved_at: null,
  ...over,
})

// ─── 1. Round trip: mapper ↔ select list ────────────────────────────────────

check('every column the row mapper reads appears in AGENDA_COLUMNS', () => {
  const body = functionBody(service, 'mapRow')
  const selected = new Set(AGENDA_COLUMNS.split(',').map(s => s.trim()))
  const reads = [...body.matchAll(/row\.([a-z_]+)/g)].map(m => m[1])
  assert.ok(reads.length > 10, 'mapRow should read the whole row; found too few fields')
  for (const field of new Set(reads)) {
    assert.ok(
      selected.has(field),
      `mapRow reads row.${field} but AGENDA_COLUMNS never selects it — it will read back ` +
      `as undefined and nothing will throw. This is the observation-roundtrip failure.`
    )
  }
})

check('every column AGENDA_COLUMNS selects exists in the migration', () => {
  for (const col of AGENDA_COLUMNS.split(',').map(s => s.trim())) {
    assert.match(
      migration, new RegExp(`\\b${col}\\b`),
      `AGENDA_COLUMNS selects "${col}" but v34_agenda.sql never declares it — every read ` +
      `would 400 the moment the table is real`
    )
  }
})

check('every query selects the full column list, never a subset', () => {
  // A hand-rolled `.select('id, status')` somewhere would reintroduce the exact gap this
  // file exists to close, and only on that one path.
  const selects = [...service.matchAll(/\.select\(([^)]*)\)/g)].map(m => m[1].trim())
  assert.ok(selects.length > 0, 'expected at least one select')
  for (const s of selects) {
    assert.equal(
      s, 'AGENDA_COLUMNS',
      `found .select(${s}) — every read must go through AGENDA_COLUMNS so the mapper and ` +
      `the query cannot drift`
    )
  }
})

// ─── 2. Code literals ↔ CHECK constraints ───────────────────────────────────

check('AGENDA_ORIGINS matches the origin CHECK exactly', () => {
  assert.deepEqual(
    [...AGENDA_ORIGINS].sort(), [...checkValues('origin')].sort(),
    'an origin the code can write but Postgres rejects is the v25 failure: the insert is ' +
    'refused, the error is logged, the caller returns normally, and the Agenda is empty'
  )
})

check('AGENDA_STATUSES matches the status CHECK exactly', () => {
  assert.deepEqual([...AGENDA_STATUSES].sort(), [...checkValues('status')].sort())
})

check('AGENDA_SENSITIVITIES matches the sensitivity CHECK exactly', () => {
  assert.deepEqual([...AGENDA_SENSITIVITIES].sort(), [...checkValues('sensitivity')].sort())
})

check('openQuestion refuses an origin the CHECK would reject, rather than letting PG do it', () => {
  const body = functionBody(service, 'openQuestion')
  assert.match(
    body, /AGENDA_ORIGINS\.includes\(origin\)/,
    'validate before the insert — a rejected row logged server-side is invisible to the founder'
  )
})

// ─── 3. The resurrection guard ──────────────────────────────────────────────

check('openQuestion reads before it writes', () => {
  const body = functionBody(service, 'openQuestion')
  assert.match(
    body, /\.select\(AGENDA_COLUMNS\)[\s\S]*\.eq\('question_key'/,
    'a blind upsert cannot see that the row it overwrites was retired on purpose'
  )
  assert.ok(
    !/\.upsert\(/.test(body),
    'openQuestion must not use .upsert() — it cannot express "unless retired"'
  )
})

check('a retired question is never re-opened by a run', () => {
  const body = functionBody(service, 'openQuestion')
  const guard = body.indexOf("existing.status === 'retired'")
  assert.notEqual(guard, -1, 'the retired check must exist')
  const insert = body.indexOf('.insert(')
  const update = body.indexOf('.update(')
  assert.ok(guard < update && guard < insert,
    'the retired guard must come BEFORE any write, or it guards nothing')
  assert.match(
    body.slice(guard, guard + 200), /return null/,
    'a retired question must short-circuit, not fall through to the refresh path'
  )
})

check('the unique index that makes the guard possible exists', () => {
  assert.match(
    migration, /CREATE UNIQUE INDEX[^;]*open_questions[^;]*\(client_id, target_domain, question_key\)/,
    'without one row per question_key, "the same question" is not a well-defined thing'
  )
})

// ─── 4. questionKey ─────────────────────────────────────────────────────────

check('questionKey is stable across punctuation, case and smart quotes', () => {
  const a = questionKey("Does Acme's enterprise push reach mid-market?")
  const b = questionKey('does acme’s ENTERPRISE push reach mid market')
  assert.equal(a, b, 'a regenerated falsifier differing only in punctuation must not mint a new row')
  assert.ok(a.length > 0 && a.length <= 180, 'key must fit the index and be non-empty')
})

check('questionKey is readable, not a hash', () => {
  assert.match(
    questionKey('Is this still true: churn stays under 4%'), /churn/,
    'when two questions collide, or fail to, you have to be able to read the key and see why'
  )
})

check('questionKey survives empty and nullish input without throwing', () => {
  assert.equal(questionKey(''), '')
  assert.equal(questionKey(null), '')
  assert.equal(questionKey(undefined), '')
})

// ─── 5. computePriority is a pure function of its inputs ────────────────────

check('priority is pure — same inputs, same answer, no mutation', () => {
  const i = item()
  const frozen = JSON.stringify(i)
  const a = computePriority(i, NOW)
  const b = computePriority(i, NOW)
  assert.equal(a, b)
  assert.equal(JSON.stringify(i), frozen, 'computePriority must not mutate its argument')
})

check('a pinned question outranks everything', () => {
  const pinned = computePriority(item({ pinned: true, origin: 'unknown', sensitivity: 'low', irrelevant_count: 9 }), NOW)
  const best = computePriority(item({ origin: 'founder', sensitivity: 'high' }), NOW)
  assert.ok(pinned > best,
    'if the founder has to argue with a scoring function to get attention, the steering is fake')
})

check('a closed question has no priority at all', () => {
  for (const status of ['answered', 'retired', 'stale']) {
    assert.equal(computePriority(item({ status }), NOW), 0, `${status} must not compete for attention`)
  }
})

check('irrelevant feedback costs more than useful feedback earns', () => {
  const base = computePriority(item(), NOW)
  const up = computePriority(item({ useful_count: 1 }), NOW)
  const down = computePriority(item({ irrelevant_count: 1 }), NOW)
  assert.ok(up > base && down < base, 'feedback must move priority in both directions')
  assert.ok(
    (base - down) > (up - base),
    'boring a founder costs more than missing something they can still ask for directly'
  )
})

check('staleness is measured from movement, not from being looked at', () => {
  const lookedAtDailyNeverMoved = item({
    opened_at: new Date(NOW - 60 * DAY).toISOString(),
    last_checked_at: new Date(NOW - 30 * DAY).toISOString(),
    last_moved_at: null,
  })
  const movedRecently = item({
    opened_at: new Date(NOW - 60 * DAY).toISOString(),
    last_moved_at: new Date(NOW - 1 * DAY).toISOString(),
  })
  assert.ok(
    computePriority(lookedAtDailyNeverMoved, NOW) > computePriority(movedRecently, NOW),
    'a question checked every morning that never resolves is the interesting one — ' +
    'measuring staleness from last_checked_at would make it look permanently fresh'
  )
})

check('staleness is capped so age alone cannot outrank sensitivity', () => {
  const ancient = computePriority(item({ sensitivity: 'low', origin: 'unknown', opened_at: new Date(NOW - 3650 * DAY).toISOString() }), NOW)
  const fresh = computePriority(item({ sensitivity: 'high', origin: 'founder' }), NOW)
  assert.ok(ancient < fresh, 'a decade-old trivial question must not outrank a live high-sensitivity bet')
})

check('a question checked today steps aside so the loop rotates', () => {
  const checked = computePriority(item({ last_checked_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }), NOW)
  const unchecked = computePriority(item({ last_checked_at: null }), NOW)
  assert.ok(checked < unchecked, 'without a damper the loop re-checks its favourite forever')
})

check('rankAgenda drops closed items and sorts most-urgent first', () => {
  const ranked = rankAgenda([
    item({ id: 'a', origin: 'unknown', sensitivity: 'low' }),
    item({ id: 'b', pinned: true }),
    item({ id: 'c', status: 'retired', pinned: true }),
    item({ id: 'd', origin: 'founder', sensitivity: 'high' }),
  ], NOW)
  assert.deepEqual(ranked.map(r => r.id), ['b', 'd', 'a'])
  assert.ok(ranked.every(r => typeof r.priority === 'number'))
})

// ─── 6. Feedback retirement ─────────────────────────────────────────────────

check('sustained irrelevance retires, but a question that ever landed keeps its place', () => {
  const body = functionBody(service, 'recordFeedback')
  assert.match(
    body, /useful === 0 && irrelevant >= IRRELEVANT_STRIKES_TO_RETIRE/,
    'the rule is three strikes AND nothing useful ever landed — a noisy question the ' +
    'founder has valued before must not be auto-retired behind their back'
  )
  assert.equal(IRRELEVANT_STRIKES_TO_RETIRE, 3)
})

check('feedback writes to the Agenda, not only to a prompt', () => {
  assert.match(
    service, /useful_count|irrelevant_count/,
    'today the thumbs only reach a {boost, suppress} list injected into a prompt as prose, ' +
    'while _signalWeights never move. Feedback has to change what is looked at.'
  )
})

// ─── 7. Harvesting a finished brief ─────────────────────────────────────────

const BRIEF = {
  what_could_change_our_view: [
    { text: 'Acme could hold enterprise pricing flat', watch_for: 'their /pricing page', source_url: 'https://acme.com/pricing' },
    { text: 'Mid-market churn could stay under 4%', watch_for: 'quarterly disclosures' },
    { text: '   ' },
  ],
  unknowns: ['Whether the new regulator guidance applies to resellers', { text: 'Renewal timing' }],
}
const CONTEXT = {
  _startupContext: {
    strategic_assumptions: [
      { statement: 'Enterprise buyers will accept self-serve onboarding', sensitivity: 'high' },
      { statement: 'Support costs scale sub-linearly', sensitivity: 'nonsense' },
      { statement: '  ' },
    ],
  },
}

check('harvestQuestions is pure and takes nothing from the network', () => {
  const body = functionBody(service, 'harvestQuestions')
  assert.ok(!/supabase|await/.test(body),
    'extraction rules must be testable on a fixture; the caller decides when to write')
})

check('every falsifier becomes a question, carrying its watch_for verbatim', () => {
  const out = harvestQuestions(BRIEF, CONTEXT, { reportId: 'r1' })
  const f = out.filter(q => q.origin === 'falsifier')
  assert.equal(f.length, 2, 'blank falsifier text must be dropped, not stored empty')
  assert.equal(f[0].watchFor, 'their /pricing page',
    'watch_for is already the concrete observable — paraphrasing it loses the founder-facing wording')
  assert.deepEqual(f[0].watchUrls, ['https://acme.com/pricing'])
  assert.equal(f[0].originRef, 'r1', 'a question must point back at the brief that opened it')
})

check('a contradiction between our own sources never becomes a standing question', () => {
  // buildFalsifiers assembles what_could_change_our_view from three sources, and one of
  // them is `context.contradictions` — "Tracxn says 26 employees, LinkedIn says 51-200".
  // That belongs in the brief, where a reader weighs it once. It must NOT go on the Agenda:
  // no number of daily page-diffs resolves a citation conflict, so the question can never
  // be answered and never leaves; and at six displayed items these crowd out the strategic
  // falsifiers that are the entire point. On the real backfill, 4 of caremother.in's 6
  // falsifiers and 2 of hginsights.com's 3 were exactly this.
  const mixed = {
    what_could_change_our_view: [
      { text: "The 'Founded Year' is inconsistent: Tracxn says 2022, CB Insights says 2021", watch_for: CONTRADICTION_WATCH_FOR },
      { text: 'If Janitri announces partnerships with major hospital chains, it would confirm the read', watch_for: 'Janitri' },
    ],
  }
  const out = harvestQuestions(mixed, {})
  assert.equal(out.length, 1, 'the contradiction must be dropped')
  assert.match(out[0].question, /^If Janitri/)
})

check('the contradiction marker is one literal, derived in both places', () => {
  const schema = read('../src/services/briefSchema.js')
  assert.match(schema, /export const CONTRADICTION_WATCH_FOR/,
    'briefSchema owns the marker; agendaService must import it')
  assert.match(service, /import \{ CONTRADICTION_WATCH_FOR \} from '\.\/briefSchema\.js'/,
    'filtering on a re-typed copy of the string, or on wording like /inconsistent/, would ' +
    'silently stop matching the day the brief rephrases it — one list, derived everywhere, ' +
    'the same rule as signalTaxonomy and sourceClass')
  assert.ok(!/An unresolved contradiction/.test(service.replace(/^.*CONTRADICTION_WATCH_FOR.*$/gm, '')),
    'the literal must not be duplicated in agendaService')
})

check('gate B3 guarantees there is always something to harvest', () => {
  // briefPolicy B3 is blocking and requires >= 2 falsifiers, so a brief that published
  // cannot have zero. If that ever changes, the Agenda silently stops being fed.
  const policy = read('../src/services/agents/policies/briefPolicy.js')
  assert.match(policy, /falsifier/i, 'B3 must still exist for the Agenda to have a reliable feedstock')
})

check('assumptions become questions and keep a valid sensitivity, dropping an invalid one', () => {
  const out = harvestQuestions(BRIEF, CONTEXT)
  const a = out.filter(q => q.origin === 'assumption')
  assert.equal(a.length, 2, 'blank statements dropped')
  assert.equal(a[0].sensitivity, 'high')
  assert.equal(a[1].sensitivity, null,
    'an out-of-range sensitivity must become null, not be passed through to be rejected by the CHECK')
  assert.match(a[0].question, /^Is this still true: /)
})

check('unknowns are harvested whether they are strings or objects', () => {
  const out = harvestQuestions(BRIEF, CONTEXT)
  assert.equal(out.filter(q => q.origin === 'unknown').length, 2)
})

check('harvest dedupes on the same key so one run cannot open the same question twice', () => {
  const dupe = {
    what_could_change_our_view: [
      { text: 'Acme could hold pricing flat' },
      { text: "acme could hold pricing flat!" },
    ],
  }
  assert.equal(harvestQuestions(dupe, {}).length, 1)
})

check('harvest survives a brief with nothing in it', () => {
  assert.deepEqual(harvestQuestions(null, null), [])
  assert.deepEqual(harvestQuestions({}, {}), [])
})

// ─── 8. Writer/RLS shape ────────────────────────────────────────────────────

check('no auth.uid()-gated RPC is introduced for a table the worker must write', () => {
  assert.ok(
    !/SECURITY DEFINER/.test(migrationDDL),
    'set_current_company_context authorises via auth.uid(), which is NULL in the worker — ' +
    'that is why company_contexts writes are browser-only. The Agenda is written by BOTH ' +
    'sides, so an auth.uid()-gated RPC would make the daily loop silently write nothing.'
  )
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/, 'the browser path still needs RLS')
})

check('reads and daily_checks are read-only to the founder', () => {
  for (const table of ['reads', 'daily_checks']) {
    const m = migration.match(new RegExp(`CREATE POLICY "Tenant isolated read ${table}"[\\s\\S]*?;`))
    assert.ok(m, `${table} needs a tenant read policy`)
    assert.match(m[0], /FOR SELECT/,
      `a founder-editable ${table} row would undermine the evidence trail`)
  }
})

check('a daily firing can only be recorded once per company per day', () => {
  assert.match(
    migration, /CREATE UNIQUE INDEX[^;]*daily_checks[^;]*\(client_id, target_domain, checked_on\)/,
    'a re-fired cron must be a no-op, not a double spend — same discipline as ' +
    "completeIntelligenceJob's compare-and-set"
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
