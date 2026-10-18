/**
 * Connector tests.
 *
 * Two things are pinned here, both silent when broken:
 *   1. Geo routing — calling SAM.gov for a Bengaluru-only founder spends a request to
 *      retrieve nothing, and worse, makes the brief look like US procurement was checked.
 *   2. Fail-open behaviour — a missing key or a dead upstream must never throw. Seven
 *      sources means seven chances to take down a run that six of them could have served.
 *
 * The network is never touched: planning is pure, and the handler is exercised with a
 * stubbed fetch. Three connectors need credentials nobody has in CI, which is exactly
 * why the planner had to be separable from the fetching.
 *
 * Run: npm run test:connectors
 */
import assert from 'node:assert/strict'
import {
  planConnectorCalls,
  isConnectorEnabled,
  CONNECTORS,
  CONNECTOR_IDS,
  MAX_OBSERVATIONS_PER_CONNECTOR,
  MAX_CONNECTOR_CALLS_PER_RUN,
} from '../src/services/connectorRegistry.js'

const ctx = (over = {}) => ({
  operating_geography: 'United States',
  industry: 'health tech',
  vertical_specialization: 'maternal health',
  key_competitors: [{ name: 'RivalHealth' }, { name: 'CareCo' }],
  customer_segments: [{ segment: 'district hospitals' }],
  ...over,
})

const sourcesOf = (plan) => plan.calls.map(c => c.source)

// ── Ships dark ──────────────────────────────────────────────────────────────────
{
  assert.equal(isConnectorEnabled('hn', ''), false, 'unset flag must enable nothing')
  assert.equal(isConnectorEnabled('hn', 'all'), true)
  assert.equal(isConnectorEnabled('hn', 'hn,sec_edgar'), true)
  assert.equal(isConnectorEnabled('reddit', 'hn,sec_edgar'), false, 'subset must not leak')

  const off = planConnectorCalls(ctx(), { enabledOverride: '' })
  assert.equal(off.calls.length, 0, 'no connector may run until explicitly enabled')
  assert.equal(off.skipped.length, CONNECTOR_IDS.length, 'and every skip is accounted for')
}

// ── Geo routing ─────────────────────────────────────────────────────────────────
{
  const us = sourcesOf(planConnectorCalls(ctx({ operating_geography: 'United States' }), { enabledOverride: 'all' }))
  assert.ok(us.includes('sam_gov'), 'US founder gets US federal tenders')
  assert.ok(us.includes('sec_edgar'), 'and US filings')
  assert.ok(!us.includes('gem'), 'but not Indian procurement')
  assert.ok(!us.includes('companies_house'), 'nor UK filings')

  const india = sourcesOf(planConnectorCalls(ctx({ operating_geography: 'Bengaluru, India' }), { enabledOverride: 'all' }))
  assert.ok(india.includes('gem'), 'Indian founder gets GeM')
  assert.ok(!india.includes('sam_gov'), 'and not SAM.gov')
  assert.ok(!india.includes('contracts_finder'), 'nor UK Contracts Finder')

  const uk = sourcesOf(planConnectorCalls(ctx({ operating_geography: 'London, United Kingdom' }), { enabledOverride: 'all' }))
  assert.ok(uk.includes('contracts_finder') && uk.includes('companies_house'), 'UK founder gets UK tenders + filings')
  assert.ok(!uk.includes('sam_gov'))

  // Geo-agnostic connectors run everywhere.
  for (const geo of ['United States', 'India', 'United Kingdom', 'Mars']) {
    assert.ok(
      sourcesOf(planConnectorCalls(ctx({ operating_geography: geo }), { enabledOverride: 'all' })).includes('hn'),
      `HN must run for ${geo}`
    )
  }

  // A skip must state a reason — a silently absent source is indistinguishable from
  // one that ran and found nothing.
  const skipped = planConnectorCalls(ctx({ operating_geography: 'India' }), { enabledOverride: 'all' }).skipped
  assert.ok(skipped.find(s => s.source === 'sam_gov')?.reason, 'geo skips carry a reason')
}

// ── Tenders and filings outrank social when the budget is tight ─────────────────
{
  const plan = planConnectorCalls(ctx({ operating_geography: 'United States' }), { enabledOverride: 'all', maxCalls: 2 })
  assert.equal(plan.calls.length, 2, 'call cap respected')
  assert.ok(
    plan.calls.every(c => c.sourceClass === 'tender' || c.sourceClass === 'filing'),
    'a squeezed budget must keep the evidence a founder cannot get elsewhere, not HN'
  )
}

// ── Entity-shaped connectors ────────────────────────────────────────────────────
{
  // One call per competitor — these APIs answer about a company, not a market.
  const plan = planConnectorCalls(ctx({ operating_geography: 'US' }), { enabledOverride: 'sec_edgar' })
  assert.equal(plan.calls.length, 2, 'one EDGAR call per named competitor')
  assert.deepEqual(plan.calls.map(c => c.params.query), ['RivalHealth', 'CareCo'])

  // With no competitor there is nothing to look up, and the skip says so.
  const none = planConnectorCalls(ctx({ key_competitors: [] }), { enabledOverride: 'sec_edgar' })
  assert.equal(none.calls.length, 0)
  assert.match(none.skipped.find(s => s.source === 'sec_edgar').reason, /competitor/)
}

// ── Params are well-formed and capped ───────────────────────────────────────────
{
  const plan = planConnectorCalls(ctx({ operating_geography: 'UK' }), { enabledOverride: 'all' })
  for (const call of plan.calls) {
    assert.ok(call.params.limit <= MAX_OBSERVATIONS_PER_CONNECTOR, `${call.source} respects the per-connector cap`)
    assert.ok(call.params.days > 0, `${call.source} sends a lookback window`)
    assert.ok(
      call.params.query || call.params.terms?.length,
      `${call.source} must send something to search on`
    )
    assert.ok(CONNECTORS[call.source], 'planned source exists in the registry')
  }
  assert.ok(plan.calls.length <= MAX_CONNECTOR_CALLS_PER_RUN)
}

// ── Registry integrity ──────────────────────────────────────────────────────────
{
  const VALID_CLASSES = new Set(['primary_company', 'filing', 'tender', 'government', 'review', 'social', 'research', 'analyst', 'news', 'code'])
  for (const [id, c] of Object.entries(CONNECTORS)) {
    assert.equal(c.id, id, `${id} id matches its key`)
    assert.ok(VALID_CLASSES.has(c.sourceClass), `${id} declares a source_class the v20 CHECK accepts`)
    assert.ok(typeof c.buildParams === 'function', `${id} can build params`)
    assert.ok(c.geos === null || Array.isArray(c.geos), `${id} geos is null or a list`)
  }
}

// ── Connector execution fails open ─────────────────────────────────────────────
{
  const { runConnector, CONNECTOR_IDS: HANDLER_IDS } = await import('../lib/handlers/connectors.js')

  // The registry and the handler must agree on which connectors exist, or the planner
  // schedules calls that dispatch to nothing.
  assert.deepEqual([...HANDLER_IDS].sort(), [...CONNECTOR_IDS].sort(), 'registry and handler must expose the same connectors')

  const realFetch = globalThis.fetch

  // A missing credential is a configuration fact, not an error.
  {
    const saved = process.env.SAM_GOV_API_KEY
    delete process.env.SAM_GOV_API_KEY
    const r = await runConnector('sam_gov', { query: 'health' })
    assert.equal(r.disabled, true, 'missing key must self-disable')
    assert.deepEqual(r.observations, [], 'and return no observations')
    assert.ok(r.reason.includes('SAM_GOV_API_KEY'), 'and name the missing key')
    if (saved !== undefined) process.env.SAM_GOV_API_KEY = saved
  }

  // A dead upstream must not throw — one bad source cannot fail a run.
  {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    for (const id of ['hn', 'sec_edgar', 'contracts_finder', 'gem']) {
      const r = await runConnector(id, { query: 'fintech', terms: ['fintech'] })
      assert.deepEqual(r.observations, [], `${id}: a failed fetch yields no observations`)
      assert.ok(r.error, `${id}: and reports why`)
    }
    globalThis.fetch = realFetch
  }

  // An upstream that answers with garbage must not throw either.
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
    for (const id of ['hn', 'sec_edgar', 'contracts_finder']) {
      const r = await runConnector(id, { query: 'x', terms: ['x'] })
      assert.ok(Array.isArray(r.observations), `${id}: unexpected payload still yields an array`)
    }
    globalThis.fetch = realFetch
  }

  // An unknown source is rejected, never dispatched.
  {
    const r = await runConnector('../../etc/passwd', {})
    assert.deepEqual(r.observations, [])
    assert.match(r.error, /Unknown connector/)
  }

  // Normalized observations must carry what storeObservations and the v20 CHECK need.
  {
    const VALID_CLASSES = new Set(['primary_company','filing','tender','government','review','social','research','analyst','news','code'])
    globalThis.fetch = async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        hits: [{ objectID: '1', title: 'Rival raises Series B', url: 'https://x.com/a', points: 42, num_comments: 17, created_at: '2026-07-01T00:00:00Z' }],
      }),
    })
    const r = await runConnector('hn', { query: 'fintech' })
    assert.equal(r.observations.length, 1)
    const o = r.observations[0]
    for (const field of ['job', 'theme', 'source', 'source_type', 'source_class', 'data', 'url', 'title']) {
      assert.ok(o[field], `observation must carry ${field}`)
    }
    assert.ok(VALID_CLASSES.has(o.source_class), 'source_class must satisfy the v20 CHECK constraint')
    assert.match(o.data, /42 points, 17 comments/, 'engagement metadata is the reason this is a connector and not a tier')
    globalThis.fetch = realFetch
  }

  globalThis.fetch = realFetch
}

console.log('connector tests passed')
