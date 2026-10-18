/**
 * "News that matters" — from stepNews, through saveReport, back out of both readers.
 *
 * News items were scored every run and never reached a screen: saveReport did not write
 * them, so the report row had none, and the only copy sat in a news_items table nothing
 * reads. A UI section would have been empty on every reload and every shared link — the
 * failure shape the engineering notes warns about, where nothing throws and the report is quietly worse.
 * So this pins the ROUND TRIP, against a fake PostgREST and the real Supabase client:
 *
 *   - what persist writes is what mapReportRowToAppReport and the shared viewer read back;
 *   - before v28 is applied the report still saves (PGRST204 → retry without the column),
 *     and reads back as "not recorded" (null), never as "nothing moved" ([]);
 *   - every single-report loader selects the column;
 *   - Jev (JEV_NEWS) changes nothing in shadow, and in `on` drops what it calls unrelated.
 *
 * Run: npm run test:news-roundtrip
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startFakePostgrest } from './_fakePostgrest.mjs'

const pg = await startFakePostgrest()
process.env.SUPABASE_URL = pg.url
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
for (const v of ['JEV_MODE', 'JEV_NEWS']) delete process.env[v]

const {
  configureIntelligenceRuntime, resetIntelligenceRuntime, createPipelineState, runPipelineStep,
} = await import('../src/services/intelligenceService.js')
const { mapReportRowToAppReport, newsItemsFromRow, __columnCache } = await import('../src/services/reportService.js')
const { rankNews, compactNewsItem } = await import('../src/services/newsScorer.js')

const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
let quietDepth = 0
const quiet = async (fn) => {
  if (quietDepth++ === 0) console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { if (--quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}
let passed = 0
const check = async (name, fn) => {
  pg.reset(); __columnCache.reset()
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`); process.exitCode = 1 }
  finally { for (const v of ['JEV_MODE', 'JEV_NEWS']) delete process.env[v]; resetIntelligenceRuntime() }
}

const reply = (status, body) => ({ ok: status < 300, status, headers: new Headers({ 'x-llm-tokens': '80', 'x-llm-model': 'jev-test' }), json: async () => body, text: async () => JSON.stringify(body) })
/** Jev fake: a headline naming Globex is unrelated (level 0); anything else directly material. */
function transport() {
  const calls = []
  const post = async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/jev')) {
      // Match the HEADLINE line only: the company context in every state lists Globex as
      // a tracked entity, and a fake that matched it would call every item unrelated.
      const score = /HEADLINE: [^\n]*Globex/.test(body.state) ? 0 : 3
      return reply(200, { answers: { material: { type: 'score', score, levels: 4, fraction: score / 3 } } })
    }
    return reply(404, {})
  }
  return { post, calls }
}

const ENTITIES = [
  { name: 'AWS', category: 'infra' },
  { name: 'Rival', category: 'competitor' },
  { name: 'Globex', category: 'infra' },
]
const signal = (headline, url) => ({ signal_headline: headline, the_move: `${headline}. Pricing changes for cloud spend.`, relevance_score: 10, source_url: url, category: 'market', temporal_role: 'anchor' })
const SIGNALS = [
  signal('AWS raises pricing on reserved instances', 'https://news.test/aws'),
  signal('Rival cuts pricing across its cost tiers', 'https://news.test/rival'),
  signal('Globex pricing page moves a cost footnote', 'https://news.test/globex'),
]

function runState() {
  const state = createPipelineState({ company_name: 'Acme', _trackedEntities: ENTITIES, _startupContext: { exposure_weights: { cost: 1 } } })
  state.memory = { lookbackMonths: 6, previousSignalsTail: [] }
  state.analyze = { order: [], batches: [], cursor: 0, signals: SIGNALS.map(s => ({ ...s })), empty: false }
  state.verify = { verdict: { verdict: 'pass', gates: [] } }
  state.summary = { our_read: 'x' }
  return state
}
const ctxFor = () => ({
  job: { clientId: 'client-1', userId: 'user-1', websiteUrl: 'https://acme.test', runTier: 'full' },
  onProgress: () => {}, timer: { canAfford: () => true, logStep() {}, remaining: () => 600000, elapsed: () => 0 }, stepped: false,
})

async function newsThenPersist({ jev = false, mode = null } = {}) {
  if (mode) process.env.JEV_NEWS = mode
  const t = transport()
  configureIntelligenceRuntime({ postJson: t.post, jev })
  const state = runState()
  const ctx = ctxFor()
  await quiet(() => runPipelineStep('news', state, ctx))
  await quiet(() => runPipelineStep('persist', state, ctx))
  return { state, t, row: (pg.db.reports || [])[0] }
}

console.log('\nnews: saved with the report, read back by both readers')

await check('what persist writes is what the mapper and the shared viewer read back', async () => {
  const { state, row } = await newsThenPersist()
  assert.ok(row, 'the report was saved')
  const written = state.report.newsItems
  assert.ok(written.length >= 2, `expected news items from the run, got ${written.length}`)
  assert.deepEqual(row.news_items, written, 'the row carries exactly the in-run items')
  assert.deepEqual(mapReportRowToAppReport(row).newsItems, written)
  assert.deepEqual(newsItemsFromRow(row), written)
  for (const item of row.news_items) {
    assert.ok(!('signal' in item), 'the embedded structured signal duplicates `signals` and must not be saved')
    assert.ok(['high', 'medium', 'low'].includes(item.relevance))
  }
})

await check('before v28: the report still saves, and reads back as "not recorded", not "nothing moved"', async () => {
  pg.missingColumns.add('reports.news_items')
  const { row } = await newsThenPersist()
  assert.ok(row, 'a missing column must never cost the report')
  assert.equal('news_items' in row, false)
  assert.equal(mapReportRowToAppReport(row).newsItems, null, 'null hides the section; [] would claim the run found nothing')
})

await check('a run that found nothing to list saves [] — and says so', async () => {
  const state = runState()
  state.context._trackedEntities = []
  configureIntelligenceRuntime({ postJson: transport().post })
  await quiet(() => runPipelineStep('news', state, ctxFor()))
  await quiet(() => runPipelineStep('persist', state, ctxFor()))
  assert.deepEqual(pg.db.reports[0].news_items, [])
  assert.deepEqual(mapReportRowToAppReport(pg.db.reports[0]).newsItems, [])
})

await check('every single-report loader selects the column', () => {
  // getReportById, the share-token read and the company-slug read all go through
  // lib/handlers/report.js. A narrowed select there without news_items would bring the
  // empty-on-reload bug straight back. Only the history LIST (select(COLUMNS)) may narrow.
  const handler = readFileSync(new URL('../lib/handlers/report.js', import.meta.url), 'utf8')
  const selects = [...handler.matchAll(/\.from\('reports'\)\s*\.select\('([^']*)'\)/g)].map(m => m[1])
  assert.ok(selects.length >= 3, `expected the id, token and slug reads, found ${selects.length} literal selects`)
  for (const cols of selects) {
    assert.ok(cols === '*' || /news_items/.test(cols), `a single-report loader selects "${cols}" without news_items`)
  }
  const viewer = readFileSync(new URL('../src/components/ReportViewer.jsx', import.meta.url), 'utf8')
  assert.match(viewer, /newsItems: newsItemsFromRow\(report\)/, 'the shared viewer must read news through the shared reader')
})

console.log('\nnews: Jev relevance')

await check('shadow: the saved section is exactly the formula\'s; the record says what on would change', async () => {
  // Timestamps are stamped when each run builds its signals, so they differ by construction.
  const strip = (items) => items.map(({ timestamp, ...i }) => i)
  const formula = strip((await newsThenPersist()).row.news_items)
  pg.reset(); __columnCache.reset()
  const { row, state, t } = await newsThenPersist({ jev: true })
  assert.deepEqual(strip(row.news_items), formula, 'shadow must not change the section')
  assert.equal(t.calls.filter(c => c.url.endsWith('/jev')).length, 3, 'one request per above-threshold candidate')
  assert.equal(state.jev.news.mode, 'shadow')
  assert.equal(state.jev.news.answered, 3)
  assert.equal(state.jev.news.wouldChange, 0, 'dropping Globex frees a slot, but nothing else was waiting for it')
})

await check('on: what Jev calls unrelated leaves the section, the rest carry their relevance', async () => {
  const { row } = await newsThenPersist({ jev: true, mode: 'on' })
  const urls = row.news_items.map(i => i.source_url)
  assert.ok(!urls.includes('https://news.test/globex'), 'an item Jev calls unrelated is not news that matters')
  assert.ok(urls.includes('https://news.test/aws'))
  assert.ok(row.news_items.every(i => i.jev_relevance === 1))
})

await check('rankNews: no relevance is the formula\'s own order; an unanswered item keeps its formula score', () => {
  const c = [
    { headline: 'a', exposure_relevance_score: 0.5 },
    { headline: 'b', exposure_relevance_score: 0.4 },
    { headline: 'c', exposure_relevance_score: 0.3 },
  ]
  assert.deepEqual(rankNews(c).map(i => i.headline), ['a', 'b', 'c'])
  assert.deepEqual(rankNews(c, { relevance: [null, null, null] }).map(i => i.headline), ['a', 'b', 'c'])
  // c is directly material (×1.5 → 0.45), a is background (×0.83 → 0.42): c overtakes a.
  assert.deepEqual(rankNews(c, { relevance: [1 / 3, null, 1] }).map(i => i.headline), ['c', 'a', 'b'])
  assert.deepEqual(rankNews(c, { relevance: [0, null, null] }).map(i => i.headline), ['b', 'c'])
  assert.equal(compactNewsItem({ headline: 'x', exposure_relevance_score: 0.45 }).relevance, 'high')
})

await check('the section is not empty for the scores real runs produce', async () => {
  // Three consecutive production runs (dhanda, aithon, caremother) peaked at 0.094, 0.070 and
  // 0.102. At the old 0.15 floor every one of them shipped an empty section, silently.
  // These are that run's own numbers: secondary source, platform entity, capital exposure 0.6.
  const { scoreAndFilterNews } = await import('../src/services/newsScorer.js')
  const sig = (name, mag, domain) => ({
    temporal_role: 'anchor', entity_name: name, magnitude_score: mag, domain,
    source_type: 'secondary', raw_headline: `${name} moved`, source_url: 'https://example.com/a',
  })
  const items = scoreAndFilterNews({
    signals: [sig('Google My Business', 5.13, 'capital'), sig('Google My Business', 5.04, 'distribution'), sig('Bain & Company', 2.8, 'demand')],
    entities: [{ name: 'Google My Business', category: 'platform' }],
    exposureWeights: { capital: 0.6, distribution: 0.55, demand: 0.5 },
  })
  assert.ok(items.length >= 2, `a typical current anchor reaches the section, got ${items.length}`)
  assert.equal(items[0].headline, 'Google My Business moved')
})

await check('a competitor the evidence named is stored, and read back as a watchlist entity', async () => {
  const { mergeEvidenceEntities } = await import('../src/services/competitorDiscovery.js')
  const { getTrackedEntities } = await import('../src/services/entityWatchlistGenerator.js')
  const state = runState()
  state.analyze.signals.push({
    signal_headline: 'Newco launches a rival product', the_move: 'Newco launches a rival product.',
    relevance_score: 10, source_url: 'https://news.test/newco', category: 'CompetitorLaunch',
    entity_involved: 'Newco', temporal_role: 'anchor',
  })
  // Exa knows Newco's own site; the resolved homepage must reach the stored row.
  const base = transport()
  const post = async (url, body) => url.endsWith('/exa')
    ? reply(200, { results: [{ url: 'https://www.newco.io/about', title: 'Newco' }] })
    : base.post(url, body)
  configureIntelligenceRuntime({ postJson: post })
  await quiet(() => runPipelineStep('news', state, ctxFor()))
  await quiet(() => runPipelineStep('persist', state, ctxFor()))
  const row = (pg.db.tracked_entities || []).find(e => e.name === 'Newco')
  assert.ok(row, 'persist stored the discovered competitor')
  assert.equal(row.category, 'competitor')
  assert.equal(row.metadata.source, 'evidence')
  assert.equal(row.metadata.resolved_url, 'https://www.newco.io', 'the homepage Exa resolved is stored, origin only')
  assert.ok(row.metadata.last_seen_at, 'a promotion starts its age-out clock')
  assert.deepEqual(state.discoveredCompetitors, ['Newco'])
  // …and the next run's stepMemory sees it.
  const next = mergeEvidenceEntities(ENTITIES, await getTrackedEntities('client-1'))
  assert.ok(next.some(e => e.name === 'Newco'), 'the stored row comes back through the reader the next run uses')
})

pg.close()
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
