/**
 * Temporal retrieval tests — the window travels WITH the query.
 *
 * Retrieval used to express one window for everything: `lookbackMonths × 30` days, 12
 * months on a first run. A market-sizing report and a funding announcement were fetched
 * under identical date bounds, and the provider call could not tell you which kind of
 * evidence it was asking for.
 *
 * The rule pinned here is that every query bucket declares its window explicitly —
 * `current` (6mo, dated events), `context` (12mo, explanatory material) or `profile`
 * (unbounded, entity pages). A bucket missing from that map is the failure shape this
 * codebase already paid for once: competitor_discovery and adjacent_trends were absent
 * from QUERY_BUCKET_THEMES and every query they generated was silently dropped.
 *
 * Run: npm run test:temporal-retrieval
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildTemporalPolicy } from '../src/services/temporalPolicy.js'
import {
  QUERY_BUCKET_THEMES,
  QUERY_BUCKET_WINDOWS,
  buildQueryItems,
  searchQuery,
  fetchExaSearch,
  configureIntelligenceRuntime,
  resetIntelligenceRuntime,
} from '../src/services/intelligenceService.js'

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
const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

const POLICY = buildTemporalPolicy(new Date('2026-09-19T11:30:00.000Z'))
const VALID_WINDOWS = new Set(['current', 'context', 'profile'])

// ─── completeness ───────────────────────────────────────────────────────────

console.log('\nwindow map completeness')

check('every query bucket declares a retrieval window', () => {
  const missing = Object.keys(QUERY_BUCKET_THEMES).filter(b => !QUERY_BUCKET_WINDOWS[b])
  assert.deepEqual(
    missing, [],
    `buckets with no window: ${missing.join(', ')}. A bucket whose window is not declared `
    + `cannot be retrieved under the right date bounds — add it to QUERY_BUCKET_WINDOWS.`
  )
})

check('no window map entry exists for a bucket that does not exist', () => {
  const orphans = Object.keys(QUERY_BUCKET_WINDOWS).filter(b => !QUERY_BUCKET_THEMES[b])
  assert.deepEqual(orphans, [], `orphaned window entries: ${orphans.join(', ')}`)
})

check('every declared window is one of the three real windows', () => {
  for (const [bucket, window] of Object.entries(QUERY_BUCKET_WINDOWS)) {
    assert.ok(VALID_WINDOWS.has(window), `${bucket} declares unknown window "${window}"`)
  }
})

// ─── assignment ─────────────────────────────────────────────────────────────

console.log('\nwindow assignment')

check('dated-event buckets retrieve on the current window', () => {
  for (const bucket of [
    'competitor_intel', 'talent_signals', 'funding_intel', 'customer_shifts',
    'regulatory_lens', 'market_expansion', 'industry_momentum', 'demand_signals',
    'assumption_lens',
  ]) {
    assert.equal(QUERY_BUCKET_WINDOWS[bucket], 'current', `${bucket} should be current`)
  }
})

check('regional press and government are current — they are dated press and policy', () => {
  assert.equal(QUERY_BUCKET_WINDOWS.tier_regional_news, 'current')
  assert.equal(QUERY_BUCKET_WINDOWS.tier_government, 'current')
})

check('research-shaped tiers retrieve on the twelve-month context window', () => {
  for (const bucket of [
    'tier_research', 'tier_analyst', 'tier_discourse',
    'tier_reviews', 'tier_technology', 'tier_supply',
  ]) {
    assert.equal(QUERY_BUCKET_WINDOWS[bucket], 'context', `${bucket} should be context`)
  }
})

check('competitor discovery is a profile lookup, not an event search', () => {
  // "Who competes with us" is an entity question. Bounding it by publication date
  // filters out the undated company pages it exists to find.
  assert.equal(QUERY_BUCKET_WINDOWS.competitor_discovery, 'profile')
})

check('adjacent market movement is context — a trend needs more than two quarters', () => {
  assert.equal(QUERY_BUCKET_WINDOWS.adjacent_trends, 'context')
})

check('the founder inquiry retrieves on the context window', () => {
  // decision_lens asks a strategic question ("should we deepen India or open the US").
  // Bounding it to six months of news would starve exactly the question it was asked.
  assert.equal(QUERY_BUCKET_WINDOWS.decision_lens, 'context')
})

// ─── the window travels with the query ──────────────────────────────────────

console.log('\nthe window travels with the query')

check('built query items carry their window, not just their theme', () => {
  const items = buildQueryItems({
    funding_intel: ['RivalPay Series B 2026'],
    tier_research: ['payments interchange working paper'],
  })
  const funding = items.find(i => i.query.includes('Series B'))
  const research = items.find(i => i.query.includes('working paper'))

  assert.equal(funding.retrievalWindow, 'current')
  assert.equal(research.retrievalWindow, 'context')
  // The existing contract must survive untouched.
  assert.equal(funding.theme, 'funding_intel')
  assert.equal(research.tier, 'research')
})

check('an unmapped bucket is dropped rather than retrieved under a guessed window', () => {
  const items = buildQueryItems({ not_a_real_bucket: ['anything'] })
  assert.equal(items.length, 0)
})

check('blank and whitespace queries are dropped', () => {
  assert.equal(buildQueryItems({ funding_intel: ['', '   ', null] }).length, 0)
})

check('the selected-query projection preserves the window', () => {
  // stepGenerateQueries narrows candidates to a fixed field set before checkpointing.
  // The old projection listed {query, theme, tier} explicitly, so a new field added
  // upstream would be silently dropped at exactly this line.
  const src = readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  const after = src.split('.slice(0, budget().maxQueries)')[1]
  assert.ok(after, 'could not locate the selected-query projection')
  const projection = after.match(/\.map\(\(\{[^}]*\}\)\s*=>\s*\(\{[^}]*\}\)\)/)
  assert.ok(projection, 'could not locate the projection .map()')
  assert.match(
    projection[0], /retrievalWindow[\s\S]*retrievalWindow/,
    'the projection must both destructure AND re-emit retrievalWindow'
  )
})

// ─── provider parameters ────────────────────────────────────────────────────

console.log('\nprovider date parameters')

/** Capture every gateway request searchQuery makes. */
function captureRuntime(results = []) {
  const calls = []
  configureIntelligenceRuntime({
    postJson: async (endpoint, body) => {
      calls.push({ endpoint, body })
      return { ok: true, status: 200, json: async () => ({ results }), text: async () => '' }
    },
  })
  return calls
}

const searchBody = (calls) => calls.find(c => c.endpoint.endsWith('/search'))?.body
const exaBodies = (calls) => calls.filter(c => c.endpoint.endsWith('/exa')).map(c => c.body)

await checkAsync('a current general-topic search asks for the six-month window', async () => {
  const calls = captureRuntime()
  await searchQuery('RivalPay pricing change', {
    theme: 'competitor_intel', retrievalWindow: 'current', temporalPolicy: POLICY,
  })
  const body = searchBody(calls)
  assert.equal(body.topic, 'general')
  assert.equal(body.start_date, '2026-03-19')
  assert.equal(body.end_date, '2026-09-19')
  resetIntelligenceRuntime()
})

await checkAsync('a context general-topic search asks for the twelve-month window', async () => {
  const calls = captureRuntime()
  await searchQuery('payments interchange research', {
    theme: 'customer_shifts', tier: 'research', retrievalWindow: 'context', temporalPolicy: POLICY,
  })
  const body = searchBody(calls)
  assert.equal(body.start_date, '2025-09-19')
  assert.equal(body.end_date, '2026-09-19')
  resetIntelligenceRuntime()
})

await checkAsync('a news-topic current search asks in days, because Tavily ignores dates there', async () => {
  const calls = captureRuntime()
  await searchQuery('RivalPay Series B', {
    theme: 'funding_intel', retrievalWindow: 'current', temporalPolicy: POLICY,
  })
  const body = searchBody(calls)
  assert.equal(body.topic, 'news')
  assert.equal(body.days, 184)
  assert.equal(body.start_date, undefined, 'sending both lets the ignored half look applied')
  resetIntelligenceRuntime()
})

await checkAsync('a query with no declared window defaults to current, never to unbounded', async () => {
  // A job checkpointed before this feature resumes with selected items that have no
  // retrievalWindow. Defaulting to unbounded would quietly reopen the whole problem.
  const calls = captureRuntime()
  await searchQuery('RivalPay hiring', { theme: 'talent_signals', temporalPolicy: POLICY })
  const body = searchBody(calls)
  assert.equal(body.start_date, '2026-03-19')
  resetIntelligenceRuntime()
})

// ─── Exa ────────────────────────────────────────────────────────────────────

console.log('\nExa publication bounds')

await checkAsync('Exa receives BOTH publication bounds, not just the start', async () => {
  // Sending only startPublishedDate leaves the window open-ended into the future, so a
  // misdated source sails through the very filter that was meant to bound it.
  const calls = captureRuntime()
  await fetchExaSearch('RivalPay Series B', { retrievalWindow: 'current', temporalPolicy: POLICY })
  const body = exaBodies(calls)[0]
  assert.equal(body.startPublishedDate, '2026-03-19')
  assert.equal(body.endPublishedDate, '2026-09-19')
  resetIntelligenceRuntime()
})

await checkAsync('an Exa context search spans twelve months', async () => {
  const calls = captureRuntime()
  await fetchExaSearch('sector analyst outlook', { retrievalWindow: 'context', temporalPolicy: POLICY })
  const body = exaBodies(calls)[0]
  assert.equal(body.startPublishedDate, '2025-09-19')
  assert.equal(body.endPublishedDate, '2026-09-19')
  resetIntelligenceRuntime()
})

await checkAsync('a profile lookup sends no publication bounds at all', async () => {
  // Competitor discovery and context assembly want entity pages, which are undated.
  // Bounding them by publication date filters out the homepage we went there for.
  const calls = captureRuntime()
  await fetchExaSearch('similar companies', { retrievalWindow: 'profile', temporalPolicy: POLICY })
  const body = exaBodies(calls)[0]
  assert.equal(body.startPublishedDate, undefined)
  assert.equal(body.endPublishedDate, undefined)
  resetIntelligenceRuntime()
})

await checkAsync('the Exa tier augmentation inherits the query window', async () => {
  const calls = captureRuntime([{ url: 'https://example.com/a', title: 'A', content: 'x' }])
  await searchQuery('interchange working paper', {
    theme: 'customer_shifts', tier: 'research', retrievalWindow: 'context', temporalPolicy: POLICY,
  })
  const aug = exaBodies(calls)[0]
  assert.ok(aug, 'tier queries must also run against Exa')
  assert.equal(aug.startPublishedDate, '2025-09-19')
  assert.equal(aug.endPublishedDate, '2026-09-19')
  resetIntelligenceRuntime()
})

// ─── observations carry the window ──────────────────────────────────────────

console.log('\nobservations carry their retrieval window')

await checkAsync('each observation records the window it was retrieved under', async () => {
  const calls = captureRuntime([
    { url: 'https://example.com/a', title: 'A', content: 'body', published_date: '2026-07-01' },
  ])
  const { observations } = await searchQuery('RivalPay pricing change', {
    theme: 'competitor_intel', retrievalWindow: 'current', temporalPolicy: POLICY,
  })
  assert.equal(observations.length, 1)
  assert.equal(observations[0].retrieval_window, 'current')
  assert.equal(observations[0].retrieval_start_date, '2026-03-19')
  // published_date stays the provider's date — the window is metadata about the ASK,
  // not a claim about when the thing happened.
  assert.equal(observations[0].published_date, '2026-07-01')
  resetIntelligenceRuntime()
  void calls
})

console.log(`\n${passed} checks passed`)
if (process.exitCode) console.error('FAILED')
