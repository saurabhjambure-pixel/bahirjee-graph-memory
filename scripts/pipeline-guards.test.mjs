import assert from 'node:assert/strict'

import {
  createPipelineState,
  configureIntelligenceRuntime,
  runPipelineStep,
} from '../src/services/intelligenceService.js'

const ctx = {
  job: { clientId: null, analysisMode: 'company' },
  stepped: false,
  onProgress() {},
  timer: { canAfford: () => true, logStep() {} },
}

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

console.log('\npipeline guards\n')

await check('search initializes its cursor for a subset run', async () => {
  const state = createPipelineState({ company_name: 'Acme' })
  state.queries = { buckets: {}, selected: [] }

  await runPipelineStep('search', state, ctx)

  assert.deepEqual(state.search, {
    cursor: 0,
    total: 0,
    phase: 'done',
    candidates: [],
    served: { tavily: 0, exa: 0 },
    servedByWindow: {},
  })
})

await check('search normalizes the daily plan query strings', async () => {
  const calls = []
  configureIntelligenceRuntime({
    postJson: async (url, body) => {
      calls.push({ url, body })
      return { ok: true, status: 200, async json() { return { results: [] } } }
    },
  })

  const state = createPipelineState({ company_name: 'Acme' })
  state.queries = { buckets: {}, selected: ['Acme customer demand'] }

  await runPipelineStep('search', state, ctx)

  assert.equal(calls[0]?.body?.query, 'Acme customer demand')
})

await check('express signals prevent analyze from being marked empty', async () => {
  const state = createPipelineState({ company_name: 'Acme', industry: 'technology' })
  state._observations = []
  state.express = {
    obsIds: [],
    urlKeys: [],
    analyzedCount: 0,
    signals: [{
      signal_headline: 'A competitor launched',
      the_move: 'A competitor launched a product',
      source_url: 'https://example.com/news',
      category: 'CompetitorLaunch',
    }],
  }

  await runPipelineStep('analyze', state, ctx)

  assert.equal(state.analyze.empty, false)
  assert.equal(state.analyze.signals.length, 1)
})

console.log(`\n${passed} checks passed\n`)
