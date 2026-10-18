/**
 * What the Gemini gateway actually sends, per job — against a fake Gemini API.
 *
 * The 2.5 family is retiring, and Gemini 3 takes different request settings: a
 * `thinkingLevel` instead of a numeric `thinkingBudget` (both together is a 400), and no
 * temperature below its 1.0 default. The gateway fails over to the next model when a model
 * rejects a request, so a wrong setting does not throw — every call just quietly runs on the
 * fallback. A source assertion cannot see that. This drives the real handler through the
 * worker's own in-process path (internalPostJson) at a local fake of the Gemini API and
 * checks the requests it makes and the headers it reports.
 *
 * Run: npm run test:gemini-request
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

let requests = []
// model → HTTP status to answer with (default 200)
let failModels = new Map()
let embedDims = 768

const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const m = /\/models\/([^:]+):(\w+)/.exec(req.url)
    const model = m?.[1]
    const method = m?.[2]
    const parsed = body ? JSON.parse(body) : {}
    requests.push({ model, method, body: parsed })

    const status = failModels.get(model)
    if (status) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `fake ${status} from ${model}` } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (method === 'batchEmbedContents') {
      res.end(JSON.stringify({ embeddings: parsed.requests.map(() => ({ values: Array(embedDims).fill(0.01) })) }))
      return
    }
    const json = parsed.generationConfig?.response_mime_type === 'application/json'
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: json ? '{"ok":true}' : 'An answer.' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 120, thoughtsTokenCount: 40 },
    }))
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

process.env.GEMINI_API_KEY = 'test-gemini-key'
process.env.GEMINI_API_BASE_URL = `http://127.0.0.1:${server.address().port}/v1beta`
process.env.INTERNAL_API_KEY = 'test-internal-key'
// The auth layer insists these exist before it checks the internal key; nothing is called.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role'
for (const v of ['GEMINI_MODEL', 'GEMINI_LIGHT_MODEL', 'GEMINI_REASONING_MODEL']) delete process.env[v]
const { internalPostJson } = await import('../lib/_internalRouteClient.js')

// Re-entrant, so overlapping calls cannot restore an already-silenced console.
const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
let quietDepth = 0
const quiet = async (fn) => {
  if (quietDepth++ === 0) console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { if (--quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}
const call = (action, payload) => quiet(() => internalPostJson('/api/gemini', { action, payload }))

const PAYLOADS = {
  buildContext: { url: 'https://acme.test', linkedin: '', rawText: 'Acme builds billing software.' },
  analyzeSignals: { context: { company_name: 'Acme' }, searchResults: '[1] a finding', startDate: '2026-01-01', lookbackMonths: 6, previousSignals: [] },
  extractDocumentIntel: { docText: 'Acme competes with Rival.', companyHint: 'Acme', todayIso: '2026-09-27' },
  generateQueries: { context: { company_name: 'Acme' }, competitors: [], dateStr: '2026-09' },
  frameDecision: { rawText: 'Should we expand into the UK market next year?', context: {} },
  generateSummary: { context: { company_name: 'Acme' }, signals: [], synthesis: {} },
  interpretShifts: { context: { company_name: 'Acme' }, shifts: [], blindSpots: [], opportunities: [] },
  generateDecisionBrief: { context: { company_name: 'Acme' }, decision: { decision_statement: 'x' }, signals: [], synthesis: {} },
  answerQuestion: { context: { company_name: 'Acme' }, signal: {}, question: 'Why does this matter?' },
}
const EXPECTED = {
  buildContext: ['gemini-3.8-flash', 'low'],
  analyzeSignals: ['gemini-3.8-flash', 'low'],
  extractDocumentIntel: ['gemini-3.8-flash', 'low'],
  answerQuestion: ['gemini-3.8-flash', 'low'],
  generateQueries: ['gemini-3.5-flash-lite', 'low'],
  frameDecision: ['gemini-3.5-flash-lite', 'low'],
  generateSummary: ['gemini-3.1-pro-preview', 'medium'],
  interpretShifts: ['gemini-3.1-pro-preview', 'medium'],
  generateDecisionBrief: ['gemini-3.1-pro-preview', 'medium'],
}

let passed = 0
const check = async (name, fn) => {
  requests = []
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('\ngemini request shape')

for (const [action, [model, level]] of Object.entries(EXPECTED)) {
  await check(`${action} leads with ${model} at thinkingLevel '${level}'`, async () => {
    const res = await call(action, PAYLOADS[action])
    assert.equal(res.status, 200, `handler returned ${res.status}: ${await res.text()}`)
    assert.equal(requests.length, 1, 'one request, no failover, on a healthy model')
    const { model: sent, body } = requests[0]
    assert.equal(sent, model)
    const cfg = body.generationConfig
    assert.deepEqual(cfg.thinkingConfig, { thinkingLevel: level })
    assert.ok(!('temperature' in cfg), 'no temperature on Gemini 3')
    assert.equal(res.headers.get('x-llm-model'), model)
    assert.equal(res.headers.get('x-llm-thoughts'), '40', 'thinking tokens must reach provenance')
    assert.equal(res.headers.get('x-llm-finish'), 'STOP')
  })
}

await check('a model that rejects the request fails over at once, and the fallback is reported', async () => {
  failModels = new Map([['gemini-3.8-flash', 400]])
  try {
    const res = await call('analyzeSignals', PAYLOADS.analyzeSignals)
    assert.equal(res.status, 200)
    const onLead = requests.filter(r => r.model === 'gemini-3.8-flash').length
    assert.equal(onLead, 1, `a 400 was resent to the same model ${onLead} times — it is not transient`)
    assert.equal(requests[1]?.model, 'gemini-3.6-flash', 'the next model in the heavy tier answers')
    assert.equal(res.headers.get('x-llm-model'), 'gemini-3.6-flash')
    assert.equal(res.headers.get('x-llm-fallbacks'), 'gemini-3.8-flash:400',
      'a call served by a fallback must say so, or it looks like the lead model answered')
  } finally {
    failModels = new Map()
  }
})

await check('an env-pinned pre-3 model gets the legacy settings, not Gemini 3 ones', async () => {
  process.env.GEMINI_MODEL = 'gemini-2.5-flash'
  try {
    await call('buildContext', PAYLOADS.buildContext)
    const { model, body } = requests[0]
    assert.equal(model, 'gemini-2.5-flash')
    assert.ok(body.generationConfig.thinkingConfig.thinkingBudget > 0)
    assert.ok(!('thinkingLevel' in body.generationConfig.thinkingConfig))
  } finally {
    delete process.env.GEMINI_MODEL
  }
})

await check('failover rebuilds the settings for the model it lands on', async () => {
  // Lead pinned to a 2.5 model that fails; the next is Gemini 3. Reusing the first body
  // would send thinkingBudget + temperature to a Gemini 3 model.
  process.env.GEMINI_MODEL = 'gemini-2.5-flash'
  failModels = new Map([['gemini-2.5-flash', 404]])
  try {
    await call('buildContext', PAYLOADS.buildContext)
    const second = requests.find(r => r.model === 'gemini-3.8-flash')
    assert.ok(second, 'expected failover to gemini-3.8-flash')
    assert.deepEqual(second.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' })
    assert.ok(!('temperature' in second.body.generationConfig))
  } finally {
    delete process.env.GEMINI_MODEL
    failModels = new Map()
  }
})

await check('no request ever carries both thinking settings', async () => {
  for (const [action, payload] of Object.entries(PAYLOADS)) await call(action, payload)
  for (const { model, body } of requests) {
    const t = body.generationConfig?.thinkingConfig || {}
    assert.ok(!(t.thinkingLevel && t.thinkingBudget != null), `${model} got both`)
  }
})

await check('embeddings use gemini-embedding-001 at 768 dims with the caller\'s task type', async () => {
  const doc = await call('embed', { texts: ['a chunk', 'another'], taskType: 'RETRIEVAL_DOCUMENT' })
  const q = await call('embed', { texts: ['a question'], taskType: 'RETRIEVAL_QUERY' })
  assert.equal(doc.status, 200)
  assert.equal(q.status, 200)
  assert.equal(requests[0].model, 'gemini-embedding-001')
  for (const r of requests[0].body.requests) {
    assert.equal(r.outputDimensionality, 768)
    assert.equal(r.taskType, 'RETRIEVAL_DOCUMENT')
  }
  assert.equal(requests[1].body.requests[0].taskType, 'RETRIEVAL_QUERY')
})

await check('an embedding of the wrong width is refused, not stored', async () => {
  embedDims = 3072
  try {
    const res = await call('embed', { texts: ['a chunk'] })
    assert.equal(res.status, 502, 'a 3072-dim vector must never reach the vector(768) column')
  } finally {
    embedDims = 768
  }
})

await check('the summary schema names every field the summary prompt asks for', async () => {
  // Gemini emits only schema fields. why_it_matters was in the prompt and not the schema, so
  // it shipped empty on every brief from 2026-08-16 and nothing threw.
  const { buildSummarySchema } = await import('../lib/handlers/gemini.js')
  const { PROMPTS } = await import('../src/services/promptUtils.js')
  const prompt = PROMPTS.buildSummary(
    { company_name: 'Acme', _startupContext: {} },
    [{ signal_headline: 'x', the_move: 'y', category: 'CompetitorLaunch', source_url: 'https://a.test' }],
    {}, null
  )
  const out = prompt.slice(prompt.indexOf('OUTPUT JSON:'))
  const asked = [...out.matchAll(/^\s{2}"([a-z_]+)":/gm)].map(m => m[1])
  assert.ok(asked.includes('why_it_matters') && asked.includes('headline'), `parsed the prompt's output keys: ${asked}`)
  const have = Object.keys(buildSummarySchema().properties)
  const missing = asked.filter(k => k !== 'assumption_status' && !have.includes(k))
  assert.deepEqual(missing, [], `prompt asks for fields the schema would silently drop: ${missing}`)
  assert.ok(have.includes('assumption_status'), 'stated-bets field is representable')
})

server.close()
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
