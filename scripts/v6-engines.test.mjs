/**
 * Structural findings — shifts, blind spots, opportunities — through the real steps and a
 * real Supabase client, against an in-process fake of PostgREST.
 *
 * The shift engine never fired. detectShifts read the "previous" patterns AFTER
 * clusterObservations had upserted this run's, so every pattern was compared with itself and
 * no threshold could be crossed. Nothing threw; every brief just said "no structural
 * shifts", and the shifts that did appear came from the rule-based fallback. That is the
 * failure shape this codebase is most exposed to, so these tests pin the round trip rather
 * than the code: rows go into a fake database, `memory` and `v6_pipeline` run for real, and
 * the assertions read what came out.
 *
 * Also pinned:
 *   - a company's first run establishes the baseline and reports no shift (without that
 *     rule, the fix above would call every theme an "emerging shift" on day one);
 *   - a replayed v6_pipeline (crash after the writes, before the checkpoint) still reports
 *     what its first attempt wrote, instead of deduping it out of the report;
 *   - Jev's confidence layer (JEV_SYNTHESIS) and Source Watch check (JEV_WATCH) change
 *     nothing in shadow, and only drop/lower in `on`.
 *
 * Run: npm run test:v6-engines
 */
import assert from 'node:assert/strict'
import { startFakePostgrest } from './_fakePostgrest.mjs'

const pg = await startFakePostgrest()
process.env.SUPABASE_URL = pg.url
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
for (const v of ['JEV_MODE', 'JEV_SYNTHESIS', 'JEV_WATCH']) delete process.env[v]

const {
  configureIntelligenceRuntime, resetIntelligenceRuntime, createPipelineState, runPipelineStep,
} = await import('../src/services/intelligenceService.js')
const { classifyShifts } = await import('../src/services/shiftEngine.js')

// ─── harness ────────────────────────────────────────────────────────────────

const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
let quietDepth = 0
const quiet = async (fn) => {
  if (quietDepth++ === 0) console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { if (--quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}
let passed = 0
const check = async (name, fn) => {
  pg.reset()
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`); process.exitCode = 1 }
  finally {
    for (const v of ['JEV_MODE', 'JEV_SYNTHESIS', 'JEV_WATCH']) delete process.env[v]
    resetIntelligenceRuntime()
  }
}

const COMPANY = 'client-1'
const CONTEXT = { company_name: 'Acme', key_competitors: ['Rival'] }
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const openTimer = () => ({ canAfford: () => true, logStep() {}, remaining: () => 600000, elapsed: () => 0 })
const ctxFor = () => ({ job: { clientId: COMPANY, websiteUrl: 'https://acme.test' }, onProgress: () => {}, timer: openTimer(), stepped: false })

const reply = (status, body) => ({ ok: status < 300, status, headers: new Headers({ 'x-llm-tokens': '90', 'x-llm-model': 'jev-test' }), json: async () => body, text: async () => JSON.stringify(body) })
/** Jev fake: P(yes) 0.9 when the state says SUPPORTED or SUBSTANTIVE, else 0.1. */
function jevTransport({ jev = 'ok', pages = {} } = {}) {
  const calls = []
  const post = async (url, body) => {
    calls.push({ url, body })
    if (url.endsWith('/scrape')) return pages[body.url] ? reply(200, { text: pages[body.url], source: 'parallel_ai' }) : reply(404, {})
    if (url.endsWith('/jev')) {
      if (jev === 'none') return reply(503, { code: 'PROVIDER_UNAVAILABLE' })
      const p = /SUPPORTED|SUBSTANTIVE/.test(body.state) ? 0.9 : 0.1
      return reply(200, { answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: 'noul', p }])) })
    }
    return reply(404, {})
  }
  return { post, calls, jevCalls: () => calls.filter(c => c.url.endsWith('/jev')) }
}

const obsRow = (i, { theme = 'pricing', days = 0, domain = `d${i}.test`, text = 'a finding' } = {}) => ({
  id: `obs-${theme}-${i}-${days}`, company_id: COMPANY, theme, created_at: ago(days),
  source_url: `https://${domain}/p${i}`, raw_text: text, entity: null,
})

/** A company whose pricing theme went from quiet (1x) to busy: 2 old observations, 10 new. */
function seedAcceleratingPricing({ previous = true } = {}) {
  pg.db.observations = [
    obsRow(1, { days: 12 }), obsRow(2, { days: 12 }),
    ...Array.from({ length: 10 }, (_, i) => obsRow(10 + i, { text: 'Rival cut prices — SUPPORTED' })),
  ]
  if (previous) {
    pg.db.patterns = [{ id: 'pat-pricing', company_id: COMPANY, theme: 'pricing', velocity_score: 1, source_diversity: 2, observation_count: 4, maturity: 'forming' }]
  }
}

async function runMemoryThenV6(state, { runtime } = {}) {
  configureIntelligenceRuntime({ postJson: runtime?.post || (async () => reply(404, {})), jev: Boolean(runtime) })
  const ctx = ctxFor()
  await quiet(() => runPipelineStep('memory', state, ctx))
  const afterMemory = JSON.parse(JSON.stringify(state))
  await quiet(() => runPipelineStep('v6_pipeline', state, ctx))
  return { afterMemory, ctx }
}
const freshState = () => createPipelineState({ ...CONTEXT })

console.log('\nshift thresholds')

await check('no baseline at all, or an empty one: nothing is a shift — the first run sets the baseline', () => {
  const busy = [{ theme: 'pricing', velocity_score: 10, source_diversity: 6, observation_count: 20 }]
  assert.deepEqual(classifyShifts(busy, []), [])
  assert.deepEqual(classifyShifts(busy, null), [])
})

await check('a pattern compared with itself never shifts — the bug, stated as a rule', () => {
  const p = { theme: 'pricing', velocity_score: 5, source_diversity: 4, observation_count: 12, maturity: 'established' }
  assert.deepEqual(classifyShifts([p], [p]), [])
})

await check('each threshold fires against a real baseline', () => {
  const base = [
    { theme: 'pricing', velocity_score: 1, source_diversity: 2, observation_count: 4, maturity: 'forming' },
    { theme: 'hiring', velocity_score: 1, source_diversity: 2, observation_count: 4, maturity: 'forming' },
    { theme: 'product', velocity_score: 1, source_diversity: 3, observation_count: 20, maturity: 'established' },
    { theme: 'other', velocity_score: 0, source_diversity: 2, observation_count: 3, maturity: 'forming' },
  ]
  const now = [
    { theme: 'pricing', velocity_score: 5, source_diversity: 2, observation_count: 12 },
    { theme: 'hiring', velocity_score: 1, source_diversity: 5, observation_count: 6 },
    { theme: 'product', velocity_score: 1, source_diversity: 3, observation_count: 6 },
    { theme: 'brand_new', velocity_score: 4, source_diversity: 2, observation_count: 4 },
  ]
  const byTheme = Object.fromEntries(classifyShifts(now, base).map(s => [s.pattern.theme, s.shiftType]))
  assert.deepEqual(byTheme, { pricing: 'emerging', hiring: 'structural', product: 'anomaly', brand_new: 'emerging' })
})

console.log('\nshift detection through the pipeline')

await check('a real acceleration fires a shift — the baseline is the pre-run pattern, not this run\'s', async () => {
  seedAcceleratingPricing()
  const state = freshState()
  await runMemoryThenV6(state)
  assert.equal(state.v6.shifts.length, 1, 'the pricing theme went 1x → 5x and must register as a shift')
  assert.equal(state.v6.shifts[0].shift_type, 'emerging')
  assert.equal(state.v6.shifts[0].baseline_velocity, 1, 'measured against the pattern as it stood before this run')
  assert.equal(pg.db.patterns.find(p => p.theme === 'pricing').velocity_score, 5, 'and the pattern itself moved on')
  assert.equal(state.v6.baseline, undefined, 'the baseline is dropped once used — it must not ride every later checkpoint')
})

await check('a company\'s first run establishes patterns and reports no shift', async () => {
  seedAcceleratingPricing({ previous: false })
  const state = freshState()
  await runMemoryThenV6(state)
  assert.ok(pg.db.patterns.length > 0, 'the first run still writes the baseline for the next one')
  assert.deepEqual(state.v6.shifts, [])
})

await check('a replayed v6_pipeline still reports the shift its first attempt wrote', async () => {
  seedAcceleratingPricing()
  const state = freshState()
  const { afterMemory, ctx } = await runMemoryThenV6(state)
  assert.equal(state.v6.shifts.length, 1)
  // Crash after the writes, before the checkpoint: the worker resumes from the state the
  // memory step checkpointed, and the database already holds this run's pattern and shift.
  const replayed = afterMemory
  await quiet(() => runPipelineStep('v6_pipeline', replayed, ctx))
  assert.equal(replayed.v6.shifts.length, 1, 'deduping against its own first attempt would publish without the shift')
  assert.equal(pg.db.shifts.filter(s => s.status === 'active').length, 1, 'and it is still one shift, not two')
})

await check('a replayed v6_pipeline still reports blind spots and opportunities it wrote', async () => {
  seedAcceleratingPricing()
  // Rival present, Acme absent, buyer language: a blind spot and an emerging opportunity.
  pg.db.observations.push(...Array.from({ length: 3 }, (_, i) => obsRow(30 + i, { text: 'rival is evaluating a pilot with buyers' })))
  const state = freshState()
  const { afterMemory, ctx } = await runMemoryThenV6(state)
  assert.equal(state.v6.blindSpots.filter(b => b.theme === 'pricing').length, 1)
  assert.equal(state.v6.opportunities.length, 1)
  const replayed = afterMemory
  await quiet(() => runPipelineStep('v6_pipeline', replayed, ctx))
  assert.equal(replayed.v6.blindSpots.filter(b => b.theme === 'pricing').length, 1)
  assert.equal(replayed.v6.opportunities.length, 1)
  assert.equal(pg.db.blind_spots.length, 1)
  assert.equal(pg.db.opportunities.length, 1)
})

await check('a finding from an EARLIER run is still deduped out, as before', async () => {
  seedAcceleratingPricing()
  pg.db.observations.push(...Array.from({ length: 3 }, (_, i) => obsRow(30 + i, { text: 'rival is evaluating a pilot with buyers' })))
  pg.db.blind_spots = [{ id: 'bs-old', company_id: COMPANY, theme: 'pricing', status: 'active', detected_at: ago(7) }]
  const state = freshState()
  await runMemoryThenV6(state)
  assert.equal(state.v6.blindSpots.filter(b => b.theme === 'pricing').length, 0)
})

await check('an unreadable baseline is disclosed, not mistaken for a first run', async () => {
  seedAcceleratingPricing()
  pg.failReads.add('patterns')
  const state = freshState()
  await runMemoryThenV6(state)
  assert.deepEqual(state.v6.shifts, [])
  assert.ok(state.degradations.some(d => /previous patterns could not be read/.test(d.reason)), 'the missing shifts must be disclosed')
})

console.log('\njev on structural findings')

const findingSetup = () => {
  seedAcceleratingPricing()
  // A second, UNSUPPORTED theme: fires a structural shift, but its evidence says nothing.
  pg.db.patterns.push({ id: 'pat-hiring', company_id: COMPANY, theme: 'hiring', velocity_score: 1, source_diversity: 1, observation_count: 3, maturity: 'forming' })
  pg.db.observations.push(...Array.from({ length: 4 }, (_, i) => obsRow(50 + i, { theme: 'hiring', days: 12, domain: `h${i}.test`, text: 'boilerplate' })))
}
// Jev only sees this run's observations; give the run the same rows the patterns came from.
const withRunObservations = (state) => {
  state._observations = pg.db.observations.map(o => ({ id: o.id, theme: o.theme, url: o.source_url, data: o.raw_text, title: o.raw_text }))
  return state
}

await check('shadow: findings are exactly the engines\' output; the record says what on would do', async () => {
  findingSetup()
  const baseline = freshState()
  await runMemoryThenV6(baseline)
  pg.reset(); findingSetup()
  const t = jevTransport()
  const state = withRunObservations(freshState())
  await runMemoryThenV6(state, { runtime: t })
  const strip = (xs) => xs.map(({ id, detected_at, created_at, ...x }) => x)
  assert.deepEqual(strip(state.v6.shifts), strip(baseline.v6.shifts), 'shadow must not touch a finding')
  const rec = state.jev.synthesis
  assert.equal(rec.mode, 'shadow')
  assert.equal(rec.n, state.v6.shifts.length + state.v6.blindSpots.length + state.v6.opportunities.length)
  assert.equal(rec.wouldDrop, 1, 'the unsupported hiring shift is the one on would drop')
  assert.ok(rec.findings.every(f => typeof f.p === 'number'))
})

await check('on: an unsupported finding leaves the report, a supported one keeps its engine confidence', async () => {
  findingSetup()
  process.env.JEV_SYNTHESIS = 'on'
  const state = withRunObservations(freshState())
  await runMemoryThenV6(state, { runtime: jevTransport() })
  assert.deepEqual(state.v6.shifts.map(s => s.theme), ['pricing'])
  const pricing = state.v6.shifts[0]
  assert.equal(pricing.confidence, 'Medium', 'Jev may lower a confidence, never raise it past what the engine measured')
  assert.equal(pricing.jev_p, 0.9)
  assert.equal(pg.db.shifts.length, 2, 'the database rows are the engines\' memory and are left alone')
})

await check('on, but no key: every finding survives unchanged', async () => {
  findingSetup()
  process.env.JEV_SYNTHESIS = 'on'
  const state = withRunObservations(freshState())
  await runMemoryThenV6(state, { runtime: jevTransport({ jev: 'none' }) })
  assert.equal(state.v6.shifts.length, 2)
  assert.ok(state.v6.shifts.every(s => s.jev_p === undefined))
})

console.log('\njev on source watch')

function seedWatch() {
  pg.db.entity_sources = [
    { id: 'src-pricing', source_type: 'pricing', url: 'https://rival.test/pricing', is_active: true, consecutive_failures: 0, entity: { id: 'e1', name: 'Rival', category: 'competitor', company_id: COMPANY } },
    { id: 'src-careers', source_type: 'careers', url: 'https://rival.test/careers', is_active: true, consecutive_failures: 0, entity: { id: 'e1', name: 'Rival', category: 'competitor', company_id: COMPANY } },
  ]
  pg.db.entity_source_snapshots = [
    { id: 's1', entity_source_id: 'src-pricing', content_hash: 'old', extract: 'Plans. Starter $10. '.repeat(40), fetched_at: ago(7) },
    { id: 's2', entity_source_id: 'src-careers', content_hash: 'old', extract: 'Careers page. '.repeat(60), fetched_at: ago(7) },
  ]
}
const PAGES = {
  'https://rival.test/pricing': 'Plans. Starter $6. SUBSTANTIVE price cut. '.repeat(30),
  'https://rival.test/careers': 'Careers page. © 2026 cookie banner. '.repeat(30),
}
async function runWatch(mode) {
  seedWatch()
  if (mode) process.env.JEV_WATCH = mode
  const t = jevTransport({ pages: PAGES })
  configureIntelligenceRuntime({ postJson: t.post, jev: true, budget: 'full' })
  const state = freshState()
  await quiet(() => runPipelineStep('watch', state, ctxFor()))
  return { state, t, urls: (state._observations || []).map(o => o.url).sort() }
}

await check('shadow: both changed pages reach the analyzer; the record names the cosmetic one', async () => {
  const { urls, state, t } = await runWatch()
  assert.deepEqual(urls, ['https://rival.test/careers', 'https://rival.test/pricing'])
  assert.equal(t.jevCalls().length, 2)
  assert.equal(state.jev.watch.wouldSuppress, 1)
})

await check('on: the cosmetic change is suppressed, and its snapshot still advanced', async () => {
  const { urls } = await runWatch('on')
  assert.deepEqual(urls, ['https://rival.test/pricing'])
  const careers = pg.db.entity_source_snapshots.filter(s => s.entity_source_id === 'src-careers')
  assert.equal(careers.length, 2, 'the new hash is recorded, so the same diff is not judged again next run')
})

pg.close()
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
