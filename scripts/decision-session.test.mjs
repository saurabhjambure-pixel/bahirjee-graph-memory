/**
 * A decision you can come back to.
 *
 * The line this whole design is for — "you chose the enterprise motion in March, assuming
 * mid-market churn stayed under 4%; that just moved" — is only true if three things were
 * recorded at the time: what was chosen, what it assumed, and when.
 *
 * The subtle one is WHAT WAS CHOSEN. Bahirjee produces a lean; the founder is free to
 * ignore it. Storing the lean and calling it the decision would make every follow-up a
 * small lie, told months later, at exactly the moment someone is relying on it. So the
 * choice is recorded separately, nullable, and never inferred.
 *
 * Run: npm run test:decision-session
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SESSION_COLUMNS,
  optionLabel,
  assembleInternalEvidence,
  describeEvidencePlan,
} from '../src/services/decisionSessionService.js'
import { FRAMEWORK_IDS } from '../src/services/decisionFrameworks.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const service = read('../src/services/decisionSessionService.js')
const migration = read('./migrations/v36_decision_sessions.sql')
const migrationDDL = migration.replace(/--[^\n]*/g, '')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

function functionBody(source, name) {
  const start = source.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`))
  assert.notEqual(start, -1, `${name} not found`)
  const paramOpen = source.indexOf('(', start)
  let parens = 0, afterParams = -1
  for (let i = paramOpen; i < source.length; i++) {
    if (source[i] === '(') parens++
    else if (source[i] === ')' && --parens === 0) { afterParams = i + 1; break }
  }
  const open = source.indexOf('{', afterParams)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// ─── Round trip ─────────────────────────────────────────────────────────────

check('every column the mapper reads is one the query selects', () => {
  const body = functionBody(service, 'mapSession')
  const selected = new Set(SESSION_COLUMNS.split(',').map(s => s.trim()))
  for (const field of new Set([...body.matchAll(/row\.([a-z_]+)/g)].map(m => m[1]))) {
    assert.ok(selected.has(field),
      `mapSession reads row.${field} but SESSION_COLUMNS never selects it — undefined, silently`)
  }
})

check('every selected column exists in v19 or v36', () => {
  const v19 = read('./migrations/v19_decision_briefs.sql')
  for (const col of SESSION_COLUMNS.split(',').map(s => s.trim())) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(v19 + migration),
      `SESSION_COLUMNS selects "${col}", declared in neither v19 nor v36`)
  }
})

check('every read goes through the full column list', () => {
  for (const s of [...service.matchAll(/\.select\(([^)]*)\)/g)].map(m => m[1].trim())) {
    assert.equal(s, 'SESSION_COLUMNS', `found .select(${s}) — the mapper and the query must not drift`)
  }
})

// ─── Code literals ↔ the CHECK ──────────────────────────────────────────────

check('the framework CHECK accepts exactly the frameworks the router can choose', () => {
  const allowed = migrationDDL.match(/framework IN \(([^)]*)\)/)[1]
    .split(',').map(x => x.trim().replace(/'/g, ''))
  assert.deepEqual([...allowed].sort(), [...FRAMEWORK_IDS].sort(),
    'a lens the router picks but Postgres rejects means the save fails, the error is logged, ' +
    'and the founder watches their session vanish — the v25 shape exactly')
})

check('an unknown framework is refused before Postgres sees it', () => {
  assert.match(functionBody(service, 'saveRouting'), /FRAMEWORK_IDS\.includes\(framework\)/,
    'a rejected row logged server-side is invisible to the person who just sat through the session')
})

// ─── The choice is recorded, never inferred ─────────────────────────────────

check('what the founder chose is stored separately from what Bahirjee leaned toward', () => {
  assert.match(migrationDDL, /chosen_option_id/)
  const fn = functionBody(service, 'recordChoice')
  assert.ok(!/leaning|leader|totals/.test(fn),
    'inferring the choice from the lean would make every follow-up a small lie told months later')
})

check('a decision can be un-made', () => {
  const fn = functionBody(service, 'recordChoice')
  assert.match(fn, /chosenOptionId \|\| null/)
  assert.match(fn, /chosenOptionId \? new Date/,
    'clearing the choice must clear its date too, or the CHECK rejects the row')
})

check('the choice and its date move together or not at all', () => {
  assert.match(migrationDDL, /\(chosen_option_id IS NULL\) = \(decided_at IS NULL\)/,
    'half a record makes "you chose this in March" unanswerable in one direction')
})

check('an unmade decision is a legitimate state', () => {
  assert.match(migrationDDL, /chosen_option_id TEXT/)
  assert.ok(!/chosen_option_id TEXT NOT NULL/.test(migrationDDL),
    'framed-and-analysed-but-not-yet-decided is common; forcing a value would put a phantom ' +
    'commitment on the Agenda')
})

check('optionLabel resolves a stored id back to something a person recognises', () => {
  const frame = { options: [{ id: 'a', label: 'Enterprise motion' }] }
  assert.equal(optionLabel(frame, 'a'), 'Enterprise motion')
  assert.equal(optionLabel(frame, 'gone'), null, 'an id whose option was edited away must not render raw')
  assert.equal(optionLabel(null, 'a'), null)
  assert.equal(optionLabel(frame, null), null)
})

// ─── The Agenda write ───────────────────────────────────────────────────────

check('the judgment is saved before the Agenda is touched', () => {
  const fn = functionBody(service, 'saveJudgment')
  assert.ok(fn.indexOf('patch(') < fn.indexOf('openQuestion'),
    'a founder who just sat through a session must not lose it because a watch item failed')
  assert.match(fn, /if \(!saved\) return null/)
})

check('a failed watch item does not fail the session', () => {
  const fn = functionBody(service, 'saveJudgment')
  const after = fn.slice(fn.indexOf('openQuestion'))
  assert.ok(!/throw/.test(after), 'the judgment is what they came for; the watching compounds later')
})

check('a decision cannot force back a question the founder retired', () => {
  assert.match(functionBody(service, 'saveJudgment'), /openQuestion/,
    'openQuestion owns the resurrection guard; writing rows directly would bypass it')
  assert.ok(!/from\('open_questions'\)/.test(service))
})

// ─── Internal evidence first ────────────────────────────────────────────────

const FRAME = {
  sub_questions: [
    'How fast do enterprise deals close in this market?',
    'What does a Kerala tender cycle require?',
  ],
  unresolved_questions: ['Whether hospital procurement favours incumbents'],
}
const SIGNALS = [
  { signal_headline: 'Enterprise deals in this market close slowly', the_move: 'Median enterprise cycle ran nine months across four vendors.' },
]

check('assembling internal evidence is pure', () => {
  assert.ok(!/supabase|await /.test(functionBody(service, 'assembleInternalEvidence')),
    'what counts as internal evidence must be testable without a database')
})

check('a question the last report already answers is not searched again', () => {
  const out = assembleInternalEvidence({ frame: FRAME, signals: SIGNALS })
  assert.ok(out.covered.some(q => /enterprise deals close/i.test(q)),
    're-searching the web for what is already on file is the waste the Agenda exists to end, ' +
    'one layer up — and worse here, because the founder is waiting')
  assert.ok(out.gaps.some(q => /Kerala tender/i.test(q)), 'and a real gap must survive')
})

check('generic word overlap is not coverage', () => {
  const out = assembleInternalEvidence({
    frame: { sub_questions: ['What does a Kerala tender cycle require?'] },
    signals: [{ signal_headline: 'Cycle times improved', the_move: 'nothing about tenders' }],
  })
  assert.equal(out.covered.length, 0,
    '"cycle" and "tenders" appearing in an unrelated sentence does not answer a question ' +
    'about Kerala tender cycles — the word that mattered is the one that is missing')
  assert.equal(out.gaps.length, 1)
})

check('the bar rises with how specific the question is', () => {
  // A false gap costs one search; a false "covered" means a question the founder asked is
  // never looked into and nothing says so. The bias must point at searching.
  const long = 'Does hospital procurement in Kerala favour incumbent maternal health vendors?'
  const partial = assembleInternalEvidence({
    frame: { sub_questions: [long] },
    signals: [{ signal_headline: 'Hospital procurement favours incumbents', the_move: 'vendors report it' }],
  })
  assert.equal(partial.gaps.length, 1, 'most of a long question present is still not the question')
})

check('with nothing on file, everything is a gap', () => {
  const out = assembleInternalEvidence({ frame: FRAME })
  assert.equal(out.gaps.length, 3)
  assert.equal(out.covered.length, 0)
  assert.equal(out.hasInternal, false)
})

check('an open agenda question counts as internal context', () => {
  const out = assembleInternalEvidence({
    frame: FRAME,
    agenda: [{ status: 'open', question: 'x' }, { status: 'retired', question: 'y' }],
  })
  assert.equal(out.internal.agenda.length, 1,
    'a retired question is not something Bahirjee is still wondering about')
})

check('only active memory cards are used', () => {
  const out = assembleInternalEvidence({
    frame: FRAME,
    cards: [{ status: 'active', title: 'a' }, { status: 'dormant', title: 'b' }],
  })
  assert.equal(out.internal.cards.length, 1)
})

check('assembling survives being handed nothing', () => {
  for (const arg of [undefined, {}, { frame: null }]) {
    const out = assembleInternalEvidence(arg)
    assert.deepEqual(out.gaps, [])
    assert.equal(out.hasInternal, false)
  }
})

check('a question naming something specific is not answered by text that never mentions it', () => {
  // The case word-counting gets wrong: 5 of 8 words matched while Kerala and maternal —
  // the two carrying the question — did not. Generic overlap must not outvote the
  // distinguishing terms.
  const out = assembleInternalEvidence({
    frame: { sub_questions: ['Does hospital procurement in Kerala favour incumbent maternal health vendors?'] },
    signals: [{ signal_headline: 'Hospital procurement favours incumbents', the_move: 'vendors report it' }],
  })
  assert.deepEqual(out.covered, [])
  assert.equal(out.gaps.length, 1)

  // And once the named thing IS on file, the same question can be covered.
  const withKerala = assembleInternalEvidence({
    frame: { sub_questions: ['Does hospital procurement in Kerala favour incumbent maternal health vendors?'] },
    signals: [{ signal_headline: 'Kerala hospital procurement favours incumbent maternal health vendors', the_move: 'across nine districts' }],
  })
  assert.equal(withKerala.covered.length, 1)
})

check('a question naming nothing specific still falls through to word overlap', () => {
  const out = assembleInternalEvidence({
    frame: { sub_questions: ['How fast do enterprise deals close in this market?'] },
    signals: [{ signal_headline: 'Enterprise deals in this market close slowly', the_move: 'nine months median' }],
  })
  assert.equal(out.covered.length, 1, 'the named-thing gate must not swallow ordinary questions')
})

check('the plan Bahirjee states is backed by what was counted', () => {
  const out = assembleInternalEvidence({ frame: FRAME, signals: SIGNALS })
  const text = describeEvidencePlan(out)
  assert.match(text, /1 thing already on file/)
  assert.match(text, /need looking up/)
  assert.equal(describeEvidencePlan({ internal: {}, covered: [], gaps: [] }), '',
    'nothing to say is said as nothing, not as an empty flourish')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
