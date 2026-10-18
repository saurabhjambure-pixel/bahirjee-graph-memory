/**
 * Jev in the pipeline — deep-read selection and analyze triage, driven through the real steps.
 *
 * Jev ships in shadow mode, so the property that matters most is the boring one: in shadow,
 * a run must be byte-for-byte the run it would have been without Jev — same pages read in
 * full, same rows analysed. Shadow data is only worth reviewing if collecting it changed
 * nothing. Then `on` must change exactly what it claims and nothing else (triage may reorder
 * WITHIN a source class, never evict a class), and an absent vendor must cost one round
 * trip, not one per item.
 *
 * Each case drives stepSearch / stepTriage / stepAnalyze through runPipelineStep against a
 * fake transport, so the observable is what the pipeline actually did: which URLs reached
 * /api/scrape, which observation ids the analyze plan kept.
 *
 * Run: npm run test:jev-pipeline
 */
import assert from 'node:assert/strict'

import {
  configureIntelligenceRuntime, resetIntelligenceRuntime, createPipelineState, runPipelineStep,
  selectDeepReadTargets, capObservations, planAnalyzeBatches, verificationForPersist,
} from '../src/services/intelligenceService.js'
import { readFileSync } from 'node:fs'
import { recordJevUse, NEUTRAL_FRACTION } from '../src/services/jevService.js'

for (const v of ['JEV_MODE', 'JEV_DEEP_READS', 'JEV_TRIAGE', 'JEV_REVIEW']) delete process.env[v]

const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
let quietDepth = 0
const quiet = async (fn) => {
  if (quietDepth++ === 0) console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { if (--quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`); process.exitCode = 1 }
  finally {
    for (const v of ['JEV_MODE', 'JEV_DEEP_READS', 'JEV_TRIAGE', 'JEV_REVIEW']) delete process.env[v]
    resetIntelligenceRuntime()
  }
}

const reply = (status, body) => ({
  ok: status < 300, status,
  headers: new Headers({ 'x-llm-tokens': '120', 'x-llm-model': 'jev-test' }),
  json: async () => body, text: async () => JSON.stringify(body),
})

/**
 * The fake transport. Jev answers the top level for any state containing MATERIAL (triage)
 * or SUBSTANCE (deep reads), the bottom level otherwise — so the tests know exactly what a
 * Jev-ranked selection must look like.
 */
function transport({ jev = 'ok', results = {} } = {}) {
  const calls = []
  const post = async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/search')) return reply(200, { results: results[body.query] || [] })
    if (url.endsWith('/scrape')) return reply(200, { text: 'Full page text. '.repeat(60), source: 'parallel_ai', title: 'Page' })
    if (url.endsWith('/exa')) return reply(500, { error: 'exa not faked' })
    if (url.endsWith('/jev')) {
      if (jev === 'none') return reply(503, { code: 'PROVIDER_UNAVAILABLE' })
      if (jev === 'fail') return reply(502, { error: 'vendor down' })
      const top = /MATERIAL|SUBSTANCE/.test(body.state)
      const answers = {}
      for (const name of Object.keys(body.questions)) {
        const score = top ? 3 : 0
        answers[name] = { type: 'score', score, levels: 4, fraction: score / 3, confidence: 0.9 }
      }
      return reply(200, { model: 'jev-test', answers })
    }
    return reply(404, { error: `unfaked ${url}` })
  }
  const to = (route) => calls.filter(c => c.url.endsWith(route))
  return { post, calls, to }
}

const CONTEXT = { company_name: 'Acme', competitive_map: { named_competitors: ['Rival'] } }
const openTimer = () => ({ canAfford: () => true, logStep() {}, remaining: () => 600000, elapsed: () => 0 })
const ctxWith = (over = {}) => ({ job: { clientId: null, websiteUrl: 'https://acme.test' }, onProgress: () => {}, timer: openTimer(), stepped: false, ...over })

// ─── deep reads ─────────────────────────────────────────────────────────────

// Two queries, three results each. Tavily prefers a1, b1, a2; the SUBSTANCE rows (a3, b2)
// are what Jev prefers. The shallow tier reads 3 pages, so ranking decides.
const r = (url, score, content) => ({ url, title: url, score, content })
const RESULTS = {
  alpha: [r('https://a1.test/p', 0.9, 'a1 snippet'), r('https://a2.test/p', 0.8, 'a2 snippet'), r('https://a3.test/p', 0.3, 'a3 SUBSTANCE snippet')],
  beta: [r('https://b1.test/p', 0.85, 'b1 snippet'), r('https://b2.test/p', 0.7, 'b2 SUBSTANCE snippet'), r('https://b3.test/p', 0.2, 'b3 snippet')],
}

function searchState(queries = ['alpha', 'beta']) {
  const state = createPipelineState({ ...CONTEXT })
  state.memory = { lookbackMonths: 6 }
  state.queries = { selected: queries.map(query => ({ query, theme: 'general' })) }
  state.search = { cursor: 0, total: queries.length, candidates: [], phase: 'search' }
  return state
}

async function runSearch({ jev = 'ok', runtimeJev = true, mode = null, queries, results = RESULTS } = {}) {
  if (mode) process.env.JEV_DEEP_READS = mode
  const t = transport({ jev, results })
  configureIntelligenceRuntime({ postJson: t.post, budget: 'shallow', jev: runtimeJev })
  const state = searchState(queries)
  await quiet(() => runPipelineStep('search', state, ctxWith()))
  return { state, t, read: t.to('/scrape').map(c => c.body.url).sort() }
}

console.log('\njev in the pipeline: deep reads')

const BASELINE_READS = ['https://a1.test/p', 'https://a2.test/p', 'https://b1.test/p']

await check('where Jev is unreachable (the browser), search makes no Jev call and reads by Tavily score', async () => {
  const { t, read, state } = await runSearch({ runtimeJev: false })
  assert.equal(t.to('/jev').length, 0)
  assert.deepEqual(read, BASELINE_READS)
  assert.equal(state.jev, undefined)
})

await check('shadow scores every candidate and reads exactly the pages it would have read without Jev', async () => {
  const { t, read, state } = await runSearch()
  assert.equal(t.to('/jev').length, 6, 'one request per candidate')
  assert.deepEqual(read, BASELINE_READS, 'shadow must not change which pages are read')
  assert.deepEqual(
    Object.fromEntries(state.search.candidates.map(c => [c.url, c.jevScore])),
    { 'https://a1.test/p': 0, 'https://a2.test/p': 0, 'https://a3.test/p': 1, 'https://b1.test/p': 0, 'https://b2.test/p': 1, 'https://b3.test/p': 0 }
  )
  const rec = state.jev.deep_reads
  assert.equal(rec.mode, 'shadow')
  assert.equal(rec.n, 6)
  assert.equal(rec.answered, 6)
  assert.equal(rec.wouldChange, 2, 'shadow must say how many reads switching on would swap (a3, b2)')
})

await check('the snippet is asked about, then dropped before the candidate is checkpointed', async () => {
  const { t, state } = await runSearch()
  const asked = t.to('/jev').map(c => c.body.state)
  assert.ok(asked.some(s => s.includes('a3 SUBSTANCE snippet')), 'the question must see the snippet')
  assert.ok(asked.every(s => s.includes('COMPANY: Acme')), 'and the company it is asked for')
  assert.ok(state.search.candidates.every(c => !('snippet' in c)), 'snippets must not ride in step state')
})

await check('on: Jev outranks Tavily score within a priority, and reads the substantive pages', async () => {
  const { read } = await runSearch({ mode: 'on' })
  assert.deepEqual(read, ['https://a1.test/p', 'https://a3.test/p', 'https://b2.test/p'])
})

await check('on, but Jev failing: every candidate is neutral and the Tavily order stands', async () => {
  const { read, state } = await runSearch({ mode: 'on', jev: 'fail' })
  assert.deepEqual(read, BASELINE_READS, 'a failed call is not a low score')
  assert.equal(state.jev.deep_reads.answered, 0)
})

await check('no key: one wave learns it, later waves never ask again', async () => {
  const many = { ...RESULTS }
  const queries = ['alpha', 'beta', 'q3', 'q4', 'q5', 'q6']
  for (const q of queries.slice(2)) many[q] = [r(`https://${q}.test/p`, 0.1, `${q} snippet`)]
  const { t, state } = await runSearch({ jev: 'none', queries, results: many })
  const jevCalls = t.to('/jev').length
  assert.ok(jevCalls >= 1 && jevCalls <= 8, `made ${jevCalls} Jev calls with no key; the first wave may fan out, no more`)
  assert.equal(state.search.jevUnavailable, true)
  const rec = state.jev.deep_reads
  assert.equal(rec.n, 10, 'every candidate is accounted for (3 + 3 + four queries of 1)')
  assert.equal(rec.answered, 0)
  assert.equal(rec.failed + rec.skipped, 10)
})

await check('selection is untouched by Jev scores unless asked to use them', () => {
  const candidates = Object.values(RESULTS).flat().map((x, i) => ({
    url: x.url, score: x.score, queryIdx: i < 3 ? 0 : 1, tier: null, jevScore: /SUBSTANCE/.test(x.content) ? 1 : 0,
  }))
  const stripped = candidates.map(({ jevScore, ...c }) => c)
  assert.deepEqual(selectDeepReadTargets(candidates, 3).map(c => c.url), selectDeepReadTargets(stripped, 3).map(c => c.url))
  // An unscored candidate is neutral: above a Jev "no", below a Jev "yes".
  const mixed = [
    { url: 'https://no.test', score: 0.9, queryIdx: 0, jevScore: 0 },
    { url: 'https://unscored.test', score: 0.1, queryIdx: 1 },
    { url: 'https://yes.test', score: 0.05, queryIdx: 2, jevScore: 1 },
  ]
  assert.deepEqual(selectDeepReadTargets(mixed, 3, { useJev: true }).map(c => c.url),
    ['https://yes.test', 'https://unscored.test', 'https://no.test'])
  assert.ok(NEUTRAL_FRACTION > 1 / 3 && NEUTRAL_FRACTION < 2 / 3, 'neutral sits between "background" and "relevant"')
})

// ─── triage ─────────────────────────────────────────────────────────────────

// 100 rows against the shallow cap of 70: 20 reviews (all kept either way — their class
// share is 20) and 80 news. The 30 MATERIAL news rows arrive LAST, so a cap that keeps the
// earliest news drops every one of them.
function triageRows(n = 100) {
  const rows = []
  for (let i = 0; i < n; i++) {
    const review = i < 20
    const material = !review && i >= n - 30
    rows.push({
      id: `obs-${String(i).padStart(3, '0')}`,
      url: `https://site${i}.test/story`,
      title: `Story ${i}`,
      data: `TITLE: Story ${i}\nURL: https://site${i}.test/story\nCONTENT: ${material ? 'MATERIAL ' : ''}${'detail '.repeat(30)}`,
      score: 0.9,
      source_class: review ? 'review' : 'news',
    })
  }
  return rows
}

// Stepped with a timer that refuses analyze batches, so stepAnalyze plans and defers without
// an LLM call. The plan is the observable.
const planOnlyTimer = (allowTriageSlices = Infinity) => {
  let slices = 0
  return {
    canAfford: (label) => {
      if (String(label).startsWith('Signal Batch')) return false
      if (String(label).startsWith('Triage')) return slices++ < allowTriageSlices
      return true
    },
    logStep() {}, remaining: () => 600000, elapsed: () => 0,
  }
}

async function runTriage({ jev = 'ok', runtimeJev = true, mode = null, rows = triageRows(), timer = planOnlyTimer(), stepped = true } = {}) {
  if (mode) process.env.JEV_TRIAGE = mode
  const t = transport({ jev })
  configureIntelligenceRuntime({ postJson: t.post, budget: 'shallow', jev: runtimeJev })
  const state = createPipelineState({ ...CONTEXT })
  state.memory = { lookbackMonths: 6, previousSignalsTail: [] }
  state._observations = rows
  const ctx = ctxWith({ timer, stepped })
  let triageOutcome = await quiet(() => runPipelineStep('triage', state, ctx))
  let invocations = 1
  while (triageOutcome.defer && invocations < 10) {
    ctx.timer = planOnlyTimer(1)
    triageOutcome = await quiet(() => runPipelineStep('triage', state, ctx))
    invocations++
  }
  ctx.timer = planOnlyTimer()
  await quiet(() => runPipelineStep('analyze', state, ctx))
  return { state, t, kept: state.analyze.order, invocations }
}

const materialIds = triageRows().filter(o => /MATERIAL/.test(o.data)).map(o => o.id)
const reviewIds = triageRows().filter(o => o.source_class === 'review').map(o => o.id)
const baseline = await (async () => { const { kept } = await runTriage({ runtimeJev: false }); return kept })()

console.log('\njev in the pipeline: triage')

await check('baseline: the cap keeps the earliest news, so no MATERIAL row survives', () => {
  assert.equal(baseline.length, 70)
  assert.equal(baseline.filter(id => materialIds.includes(id)).length, 0)
  assert.equal(baseline.filter(id => reviewIds.includes(id)).length, 20)
})

await check('where Jev is unreachable, triage does nothing at all', async () => {
  const { t, state, kept } = await runTriage({ runtimeJev: false })
  assert.equal(t.to('/jev').length, 0)
  assert.equal(state.triage, undefined)
  assert.deepEqual(kept, baseline)
})

await check('under the cap, triage never calls Jev — nothing it said could change the run', async () => {
  const { t, state } = await runTriage({ rows: triageRows(60) })
  assert.equal(t.to('/jev').length, 0)
  assert.equal(state.jev.triage.binds, false)
})

await check('shadow scores every candidate and analyses exactly the baseline rows', async () => {
  const { t, state, kept } = await runTriage()
  assert.equal(t.to('/jev').length, 100)
  assert.deepEqual(kept, baseline, 'shadow must not change what reaches analysis')
  const rec = state.jev.triage
  assert.equal(rec.mode, 'shadow')
  assert.equal(rec.answered, 100)
  assert.equal(rec.wouldChange, 30, 'shadow must say how many rows switching on would swap in')
})

await check('on: each class keeps its most material rows, and no class loses its share', async () => {
  const { kept } = await runTriage({ mode: 'on' })
  assert.equal(kept.length, 70)
  assert.equal(kept.filter(id => materialIds.includes(id)).length, 30, 'every MATERIAL row now reaches analysis')
  assert.equal(kept.filter(id => reviewIds.includes(id)).length, 20, 'a relevance score must never evict a class')
  const sorted = [...kept].sort()
  assert.deepEqual(kept, sorted, 'selection may change; the arrival order of what survives may not')
})

await check('on, but no key: one fan-out at most, then the baseline plan', async () => {
  const { t, kept, state } = await runTriage({ mode: 'on', jev: 'none' })
  assert.ok(t.to('/jev').length <= 8, `made ${t.to('/jev').length} calls with no key`)
  assert.deepEqual(kept, baseline)
  assert.equal(state.jev.triage.answered, 0)
  assert.equal(state.jev.triage.n, 100, 'every candidate is accounted for')
})

await check('stepped: triage resumes across invocations and scores each row once', async () => {
  const { t, invocations, state } = await runTriage({ timer: planOnlyTimer(1) })
  assert.ok(invocations > 1, 'expected the slice budget to force a defer')
  const asked = t.to('/jev').map(c => c.body.state.match(/site(\d+)\.test/)[1])
  assert.equal(asked.length, 100)
  assert.equal(new Set(asked).size, 100, 'a resumed slice must not re-ask a row')
  assert.equal(state.triage.cursor, 100)
})

await check('stepped: a fresh invocation that cannot afford one slice finishes rather than deferring forever', async () => {
  const { invocations, kept, state } = await runTriage({ timer: planOnlyTimer(0) })
  assert.equal(invocations, 1, 'deferring on an unmoved cursor trips the forward-progress guard')
  assert.deepEqual(kept, baseline)
  assert.equal(state.jev.triage.skipped, 100)
})

await check('monolith out of budget: unscored rows are neutral and the plan is the baseline', async () => {
  const { kept, state } = await runTriage({ mode: 'on', timer: planOnlyTimer(0), stepped: false })
  assert.deepEqual(kept.slice(0, 70), baseline)
  assert.equal(state.jev.triage.answered, 0)
})

// ─── pure pieces ────────────────────────────────────────────────────────────

await check('capObservations: no scores is the old behaviour, exactly', () => {
  const rows = triageRows()
  const quietLog = console.log; console.log = () => {}
  try {
    assert.deepEqual(capObservations(rows, 70).map(o => o.id), capObservations(rows, 70, {}).map(o => o.id))
    assert.deepEqual(capObservations(rows, 70).map(o => o.id), planAnalyzeBatches(rows, 70).order)
  } finally { console.log = quietLog }
})

await check('recordJevUse adds slices up rather than keeping the last one', () => {
  const state = {}
  recordJevUse(state, { useCase: 'triage', mode: 'shadow', n: 40, answered: 38, failed: 2 })
  recordJevUse(state, { useCase: 'triage', mode: 'shadow', n: 20, answered: 20, wouldChange: 3 })
  assert.deepEqual(state.jev.triage, { mode: 'shadow', n: 60, answered: 58, failed: 2, skipped: 0, wouldChange: 3 })
})

// ─── advisory brief review ──────────────────────────────────────────────────

// Jev fake for review: a text containing "You should" instructs; a condition containing
// "remains strong" restates the read instead of naming what would overturn it.
function reviewTransport(jev = 'ok') {
  const calls = []
  const post = async (url, body) => {
    calls.push({ url, body })
    if (!url.endsWith('/jev')) return reply(404, {})
    if (jev === 'none') return reply(503, { code: 'PROVIDER_UNAVAILABLE' })
    const answers = {}
    if (body.questions.instructs) answers.instructs = { type: 'noul', p: /You should/.test(body.state) ? 0.92 : 0.05 }
    if (body.questions.overturns) answers.overturns = { type: 'noul', p: /CONDITION: [^\n]*remains strong/.test(body.state) ? 0.1 : 0.9 }
    return reply(200, { answers })
  }
  return { post, calls }
}

function reviewState() {
  const state = createPipelineState({ ...CONTEXT })
  state.analyze = { signals: [], empty: false }
  state.verify = { verdict: { verdict: 'pass', gates: [] } }
  state.summary = {
    our_read: 'The evidence favours consolidation in mid-market billing. You should prioritise the partner channel.',
    why_it_matters: 'Two rivals cut prices in the same quarter.',
    what_could_change_our_view: [
      'If Rival reverses its price cut within two quarters, the consolidation read weakens.',
      'If demand for bundled billing remains strong, this read holds.',
    ],
  }
  state.attest = { verdict: 'pass', gates: [{ id: 'advice_leakage', status: 'pass' }] }
  return state
}

async function runReview({ mode = null, jev = 'ok', runtimeJev = true, state = reviewState() } = {}) {
  if (mode) process.env.JEV_REVIEW = mode
  const t = reviewTransport(jev)
  configureIntelligenceRuntime({ postJson: t.post, jev: runtimeJev })
  const before = JSON.parse(JSON.stringify({ summary: state.summary, attest: state.attest, verify: state.verify }))
  await quiet(() => runPipelineStep('review', state, ctxWith()))
  return { state, t, before }
}

console.log('\njev in the pipeline: advisory brief review')

await check('shadow: hits are recorded, nothing is disclosed, and the brief and verdicts are untouched', async () => {
  const { state, before } = await runReview()
  assert.deepEqual(state.review.hits.map(h => [h.field, h.kind]), [
    ['our_read', 'advice'],
    ['what_could_change_our_view[1]', 'falsifier'],
  ])
  assert.deepEqual(state.degradations, [], 'shadow must not raise a banner')
  assert.deepEqual({ summary: state.summary, attest: state.attest, verify: state.verify }, before,
    'review is advisory: it never rewrites the brief, the attestation or the verdict')
})

await check('on: one disclosure naming each flagged line — still never a verdict', async () => {
  const { state, before } = await runReview({ mode: 'on' })
  assert.equal(state.degradations.length, 1)
  const d = state.degradations[0]
  assert.equal(d.step, 'Brief review')
  assert.match(d.reason, /our_read/)
  assert.match(d.reason, /what_could_change_our_view\[1\]/)
  assert.match(d.impact, /published as written/)
  assert.deepEqual({ summary: state.summary, attest: state.attest, verify: state.verify }, before)
})

await check('on: advice attest already disclosed is not disclosed twice', async () => {
  const state = reviewState()
  state.attest.gates = [{ id: 'advice_leakage', status: 'warn', fields: [{ field: 'our_read', phrases: ['you should'] }] }]
  const { state: out } = await runReview({ mode: 'on', state })
  assert.equal(out.degradations.length, 1, 'the falsifier hit is still news to the founder')
  assert.doesNotMatch(out.degradations[0].reason, /our_read/)
})

await check('no key, or Jev unreachable: no hits, no disclosure', async () => {
  const { state } = await runReview({ mode: 'on', jev: 'none' })
  assert.deepEqual(state.review.hits, [])
  assert.deepEqual(state.degradations, [])
  const { state: browser, t } = await runReview({ mode: 'on', runtimeJev: false })
  assert.equal(t.calls.length, 0)
  assert.equal(browser.review, undefined)
})

await check('the review record is saved with the verification, next to — not inside — the verdict', async () => {
  const { state } = await runReview()
  const v = verificationForPersist(state)
  assert.equal(v.verdict, 'pass', 'review never sets the verdict')
  assert.equal(v.review.hits.length, 2)
})

// ─── persistence ────────────────────────────────────────────────────────────

await check('what persist saves carries the attestation and the Jev record, not just the verdict', () => {
  const state = {
    verify: { verdict: { verdict: 'pass', gates: [{ id: 'G1' }] } },
    attest: { verdict: 'pass', checks: [] },
    jev: { triage: { mode: 'shadow', n: 100, answered: 100 } },
  }
  const v = verificationForPersist(state)
  assert.deepEqual(v.gates, [{ id: 'G1' }])
  assert.equal(v.brief.verdict, 'pass', 'the attestation must reach the saved row')
  assert.equal(v.jev.triage.answered, 100, 'shadow mode exists to produce this record; it must be saved')
  assert.equal(verificationForPersist({}), null, 'no verdict still refuses to persist')
  assert.equal(verificationForPersist({ ...state, attest: { skipped: true }, jev: {} }).brief, undefined)

  // And persist hands THAT object to saveReport. The attestation was once merged into a
  // copy only, and the bare verdict was saved — for months, with nothing failing.
  const src = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  const persist = src.slice(src.indexOf('async function stepPersist'), src.indexOf('await saveReport({') + 2000)
  assert.match(persist, /const verification = verificationForPersist\(state\)/)
  const call = persist.slice(persist.indexOf('await saveReport({'))
  assert.match(call.slice(0, call.indexOf('});')), /\n\s+verification,\n/, 'saveReport must receive the built verification')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
