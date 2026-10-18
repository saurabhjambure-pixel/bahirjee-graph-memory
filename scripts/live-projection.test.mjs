/**
 * Live projection guards — the slice of a running pipeline's checkpoint that reaches the
 * founder's screen while the run is still executing.
 *
 * `step_outputs` holds the entire pipeline state and is rewritten in full on every
 * invocation. Historically NOTHING escaped it except `context_for_review` and `run_id`, and
 * that whitelist is the only thing standing between the client and a run's raw evidence.
 * Widening it to stream signals is the point of this feature; widening it by accident is the
 * failure mode.
 *
 * This is the round trip the engineering notes asks to be pinned: the projection reads fields the
 * checkpoint writes, and nothing here throws when they drift — the founder just silently
 * stops seeing signals, or silently starts seeing internals.
 *
 * Run: npm run test:live-projection
 */
import assert from 'node:assert/strict'

import { serializeJob } from '../lib/_intelligenceJobs.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const signal = (i) => ({
  signal_headline: `Signal ${i}`,
  source_url: `https://example.com/${i}`,
  entity_involved: `Entity ${i}`,
  evidence_quote: `quote ${i}`,
  category: 'competitor_intel'
})

const jobWith = (state, status = 'processing') => ({
  id: 'job-1',
  status,
  current_step: 'Analyzing intelligence',
  progress_log: [],
  step_outputs: {
    state,
    __control: { run_id: 'run-abc', step: 'analyze', cursor_fingerprint: '1:2:3', budget: { usd: 0.31 } },
    __graph: { agents: {} },
    __provenance: { tavily: 4 }
  }
})

console.log('\nLive projection\n')

check('is absent unless the caller asks for it', () => {
  const job = serializeJob(jobWith({ analyze: { signals: [signal(0)] } }))
  assert.equal(job.live, null, 'a plain serializeJob() call must keep its original payload')
})

check('returns signals when asked', () => {
  const { live } = serializeJob(jobWith({ analyze: { signals: [signal(0), signal(1)] } }), {})
  assert.equal(live.signalCount, 2)
  assert.equal(live.signals.length, 2)
})

check('is bounded by sinceSignal — a caught-up client gets nothing', () => {
  const state = { analyze: { signals: [signal(0), signal(1), signal(2)] } }
  const { live } = serializeJob(jobWith(state), { sinceSignal: 3 })
  assert.equal(live.signals.length, 0, 'no re-sending of signals the client already has')
  assert.equal(live.signalCount, 3, 'but the total is still reported')
})

check('slices from the cursor', () => {
  const state = { analyze: { signals: [signal(0), signal(1), signal(2)] } }
  const { live } = serializeJob(jobWith(state), { sinceSignal: 1 })
  assert.deepEqual(live.signals.map(s => s.signal_headline), ['Signal 1', 'Signal 2'])
  assert.equal(live.sliceFrom, 1)
})

check('signals a reset when dedupe shrinks the array below the cursor', () => {
  // stepAnalyze rewrites state.analyze.signals via deduplicateSignals() at the end of the
  // step. It can SHRINK. Index slicing is only valid while the array grows.
  const state = { analyze: { signals: [signal(0), signal(1)] } }
  const { live } = serializeJob(jobWith(state), { sinceSignal: 9 })
  assert.equal(live.reset, true, 'client must be told to replace, not append')
  assert.equal(live.signals.length, 2, 'and given the whole authoritative array')
  assert.equal(live.sliceFrom, 0)
})

check('caps one poll so a backlog drains over several instead of one huge response', () => {
  const many = Array.from({ length: 120 }, (_, i) => signal(i))
  const { live } = serializeJob(jobWith({ analyze: { signals: many } }), { sinceSignal: 0 })
  assert.ok(live.signals.length <= 40, `sent ${live.signals.length}`)
  assert.equal(live.signalCount, 120, 'the true total is still reported so the UI can show progress')
})

check('reads express signals before analyze has planned its batches', () => {
  // Express seeds state.analyze.signals when analyze plans. Before that it is the only
  // place early signals live — and being visible there is the entire point of the step.
  const { live } = serializeJob(jobWith({ express: { signals: [signal(0)] } }), {})
  assert.equal(live.signalCount, 1)
})

check('prefers analyze once it exists, since it is already seeded from express', () => {
  const state = { express: { signals: [signal(0)] }, analyze: { signals: [signal(0), signal(1)] } }
  const { live } = serializeJob(jobWith(state), {})
  assert.equal(live.signalCount, 2, 'must not double-count the express signals')
})

check('sends v6 once, then honours haveV6', () => {
  const state = { analyze: { signals: [] }, v6: { patterns: [{ id: 'p1' }], shifts: [] } }
  assert.ok(serializeJob(jobWith(state), {}).live.v6, 'first poll carries it')
  assert.equal(serializeJob(jobWith(state), { haveV6: true }).live.v6, null, 'later polls do not')
})

check('never leaks checkpoint internals', () => {
  const { live } = serializeJob(jobWith({ analyze: { signals: [signal(0)] } }), {})
  const blob = JSON.stringify(live)
  for (const leak of ['__control', '__graph', '__provenance', 'cursor_fingerprint', 'run-abc']) {
    assert.ok(!blob.includes(leak), `projection leaked ${leak}`)
  }
})

check('never carries raw observation text', () => {
  // Raw text is 0.5-1MB per run and is deliberately kept out of `state` entirely. If it
  // ever lands there, it must not be what gets streamed to a browser every 3 seconds.
  const state = {
    analyze: { signals: [signal(0)] },
    _observations: [{ raw_text: 'RAW_EVIDENCE_BODY'.repeat(50) }]
  }
  const { live } = serializeJob(jobWith(state), {})
  assert.ok(!JSON.stringify(live).includes('RAW_EVIDENCE_BODY'), 'raw observation text reached the client')
})

check('is null-safe before the first checkpoint', () => {
  const bare = { id: 'j', status: 'pending', progress_log: [], step_outputs: {} }
  assert.equal(serializeJob(bare, {}).live, null, 'a job with no state yet must not throw')
  assert.doesNotThrow(() => serializeJob(jobWith({}), {}))
  const { live } = serializeJob(jobWith({}), {})
  assert.equal(live.signalCount, 0)
  assert.deepEqual(live.signals, [])
})

check('is withheld once the run is over — the persisted report is authoritative then', () => {
  const state = { analyze: { signals: [signal(0)] } }
  assert.equal(serializeJob(jobWith(state, 'completed'), {}).live, null)
  assert.equal(serializeJob(jobWith(state, 'failed'), {}).live, null)
  assert.equal(serializeJob(jobWith(state, 'awaiting_context_review'), {}).live, null)
})

check('does not ship the un-normalized brief, only whether one exists', () => {
  // buildReportData runs state.summary through normalizeBriefForRun() before it is fit for
  // the UI, and that needs a pipeline ctx which does not exist in serializeJob.
  const state = { analyze: { signals: [] }, summary: { insights: [{ text: 'RAW_SUMMARY_TEXT' }] } }
  const { live } = serializeJob(jobWith(state), {})
  assert.equal(live.briefReady, true)
  assert.ok(!JSON.stringify(live).includes('RAW_SUMMARY_TEXT'), 'raw state.summary must not be streamed')
})

check('existing run_id and context_for_review contracts are unchanged', () => {
  const review = { ...jobWith({ context: { company_name: 'Acme' } }, 'awaiting_context_review') }
  const s = serializeJob(review, {})
  assert.equal(s.run_id, 'run-abc', 'run_id must still escape step_outputs')
  assert.equal(s.context_for_review.company_name, 'Acme')
  assert.equal(serializeJob(jobWith({ context: { company_name: 'Acme' } }), {}).context_for_review, null,
    'context_for_review stays scoped to the paused state')
})

check('malformed cursors degrade to the start rather than throwing', () => {
  const state = { analyze: { signals: [signal(0)] } }
  for (const bad of ['abc', '-5', undefined, null, NaN, '1e999']) {
    assert.doesNotThrow(() => serializeJob(jobWith(state), { sinceSignal: bad }), `threw on ${bad}`)
  }
})


// ── The hunt block: what carries the first ~2 minutes ────────────────────────

check('projects the watchlist from tracked entities', () => {
  const state = {
    context: { _trackedEntities: [{ name: 'Acme', category: 'competitor' }, { name: 'SEBI', category: 'regulator' }] }
  }
  const { live } = serializeJob(jobWith(state), {})
  assert.deepEqual(live.hunt.watchlist, [
    { name: 'Acme', category: 'competitor' },
    { name: 'SEBI', category: 'regulator' }
  ])
})

check('falls back to confirmed competitors before entities are resolved', () => {
  // The founder confirms competitors on the review screen, and stepDiscoverCompetitors
  // early-returns when they are already set — so this is the normal run, not the edge case.
  const objForm = { context: { key_competitors: [{ name: 'Rival Co' }] } }
  const strForm = { context: { key_competitors: ['Rival Co'] } }
  for (const state of [objForm, strForm]) {
    const { live } = serializeJob(jobWith(state), {})
    assert.equal(live.hunt.watchlist[0].name, 'Rival Co')
  }
})

check('projects the real queries and their progress', () => {
  const state = {
    queries: { selected: [{ query: 'acme funding 2026' }, { query: 'acme hiring' }] },
    search: { cursor: 4, total: 22, candidates: [] }
  }
  const { live } = serializeJob(jobWith(state), {})
  assert.deepEqual(live.hunt.queries, ['acme funding 2026', 'acme hiring'])
  assert.deepEqual(live.hunt.queryProgress, { cursor: 4, total: 22 })
})

check('projects deduped hostnames, never the candidates themselves', () => {
  // search.candidates holds ~132 result objects with titles and content snippets. Shipping
  // it on a 3s poll is the mistake the 512KB checkpoint cap exists to prevent.
  const state = {
    search: {
      cursor: 0, total: 4,
      candidates: [
        { url: 'https://www.techcrunch.com/a', title: 'T1', content: 'SNIPPET_BODY_ONE' },
        { url: 'https://techcrunch.com/b', title: 'T2', content: 'SNIPPET_BODY_TWO' },
        { url: 'https://sec.gov/filing', title: 'T3', content: 'SNIPPET_BODY_THREE' }
      ]
    }
  }
  const { live } = serializeJob(jobWith(state), {})
  assert.deepEqual(live.hunt.sourceHosts, ['techcrunch.com', 'sec.gov'], 'www stripped and deduped')
  const blob = JSON.stringify(live)
  for (const leak of ['SNIPPET_BODY_ONE', 'SNIPPET_BODY_TWO', 'SNIPPET_BODY_THREE', '/filing']) {
    assert.ok(!blob.includes(leak), `candidate payload leaked: ${leak}`)
  }
})

check('bounds every hunt list', () => {
  const state = {
    context: { _trackedEntities: Array.from({ length: 200 }, (_, i) => ({ name: `E${i}`, category: 'competitor' })) },
    queries: { selected: Array.from({ length: 200 }, (_, i) => ({ query: `q${i}` })) },
    search: { cursor: 0, total: 200, candidates: Array.from({ length: 400 }, (_, i) => ({ url: `https://h${i}.com/x` })) }
  }
  const { live } = serializeJob(jobWith(state), {})
  assert.ok(live.hunt.watchlist.length <= 24, `watchlist ${live.hunt.watchlist.length}`)
  assert.ok(live.hunt.queries.length <= 24, `queries ${live.hunt.queries.length}`)
  assert.ok(live.hunt.sourceHosts.length <= 40, `hosts ${live.hunt.sourceHosts.length}`)
})

check('reports watch and collect progress when those steps have run', () => {
  const state = { watch: { checked: 14, changed: 3 }, collect: { calls: 2, collected: 7 } }
  const { live } = serializeJob(jobWith(state), {})
  assert.deepEqual(live.hunt.watch, { checked: 14, changed: 3 })
  assert.deepEqual(live.hunt.collect, { calls: 2, collected: 7 })
})

check('hunt is null-safe on a bare checkpoint', () => {
  const { live } = serializeJob(jobWith({}), {})
  assert.deepEqual(live.hunt.watchlist, [])
  assert.deepEqual(live.hunt.queries, [])
  assert.deepEqual(live.hunt.sourceHosts, [])
  assert.equal(live.hunt.queryProgress, null)
  assert.equal(live.hunt.watch, null)
})

check('survives malformed urls and entities without throwing', () => {
  const state = {
    context: { _trackedEntities: [{ category: 'competitor' }, null, { name: 'Ok' }] },
    search: { cursor: 0, total: 1, candidates: [{ url: 'not a url' }, {}, null, { url: 'https://good.com/x' }] }
  }
  let live
  assert.doesNotThrow(() => { live = serializeJob(jobWith(state), {}).live })
  assert.deepEqual(live.hunt.watchlist, [{ name: 'Ok', category: null }], 'nameless entities dropped')
  assert.deepEqual(live.hunt.sourceHosts, ['good.com'], 'unparseable urls dropped')
})

console.log(`\n${passed} checks passed\n`)
