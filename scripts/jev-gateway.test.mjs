/**
 * Jev gateway + client — against a fake TypeSafe API.
 *
 * Jev is wired in shadow mode first, and the real API could not be reached from the
 * environment this was built in. So the properties that matter are the ones that hold
 * without it: the request leaves in the documented shape, limits are enforced before
 * anything is sent, every failure becomes "no answer" (never an exception, never a guess),
 * and a broken or absent vendor cannot stall a pipeline step.
 *
 * Run: npm run test:jev-gateway
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

let vendorCalls = []
let vendorMode = 'ok'          // ok | fail | slow
const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    vendorCalls.push({ auth: req.headers.authorization, url: req.url, body: parsed })
    const reply = () => {
      if (vendorMode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'vendor down' } }))
      }
      const answers = {}
      for (const [name, q] of Object.entries(parsed.questions || {})) {
        if (q.type === 'noul') answers[name] = { noul: 0.83 }
        if (q.type === 'score') answers[name] = { score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 }, confidence: 0.6 }
        if (q.type === 'choice') answers[name] = { choice: name === 'bogus' ? 'not-an-option' : Object.keys(q.criteria)[0], confidence: 0.9 }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers }))
    }
    vendorMode === 'slow' ? setTimeout(reply, 150) : reply()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

process.env.JEV_API_URL = `http://127.0.0.1:${server.address().port}/v1/systemone`
process.env.JEV_API_KEY = 'test-jev-key'
process.env.INTERNAL_API_KEY = 'test-internal-key'
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role'

const { internalPostJson } = await import('../lib/_internalRouteClient.js')
const { handler } = await import('../lib/handlers/jev.js')
const {
  createJevClient, jevMode, noulQuestion, scoreQuestion, choiceQuestion, pYes, scoreFraction, compactContext, itemState,
} = await import('../src/services/jevService.js')

// Re-entrant: concurrent calls (decideEach runs several at once) must not each save and
// restore the console, or the last one to finish restores the silenced one — and every
// later line, failures included, disappears while the run still exits 0.
const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
let quietDepth = 0
const quiet = async (fn) => {
  if (quietDepth++ === 0) console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { if (--quietDepth === 0) Object.assign(console, REAL_CONSOLE) }
}
const post = (url, body) => quiet(() => internalPostJson(url, body))

const LEVELS = ['unrelated', 'tangential', 'relevant', 'directly material']
const request = (over = {}) => ({
  state: itemState('COMPANY: Acme', 'SOURCE', 'Rival cut prices by 20%.'),
  questions: {
    material: scoreQuestion('How material is this source to the company?', LEVELS),
    substantive: noulQuestion('Is this a substantive change?'),
    kind: choiceQuestion('What kind of move is this?', { pricing: 'a price change', product: 'a product change' }),
  },
  ...over,
})

let passed = 0
const check = async (name, fn) => {
  vendorCalls = []
  vendorMode = 'ok'
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('\njev gateway')

await check('the request leaves in the documented shape, with the key as a bearer token', async () => {
  const res = await post('/api/jev', request())
  assert.equal(res.status, 200, await res.text())
  assert.equal(vendorCalls.length, 1)
  const { auth, url, body } = vendorCalls[0]
  assert.equal(auth, 'Bearer test-jev-key')
  assert.equal(url, '/v1/systemone')
  assert.equal(body.model, 'jev-latest')
  assert.equal(typeof body.state, 'string')
  assert.deepEqual(Object.keys(body.questions).sort(), ['kind', 'material', 'substantive'])
  assert.deepEqual(body.questions.material.criteria, LEVELS, 'score levels are an ordered array')
  assert.equal(res.headers.get('x-llm-model'), 'jev-1.13.0')
  assert.ok(Number(res.headers.get('x-llm-tokens')) > 0, 'input tokens are reported for spend')
})

await check('answers are normalised: P(yes), a score as a fraction of its scale, a known choice', async () => {
  const { answers } = await (await post('/api/jev', request())).json()
  assert.equal(pYes(answers.substantive), 0.83)
  assert.equal(answers.material.score, 2)
  assert.equal(scoreFraction(answers.material), 2 / 3, 'score 2 on a 4-level scale is 2/3 of the way up')
  assert.equal(answers.kind.choice, 'pricing')
})

await check('a choice outside the offered options is null, not trusted', async () => {
  const { answers } = await (await post('/api/jev', request({
    questions: { bogus: choiceQuestion('Pick one', { a: 'first', b: 'second' }) },
  }))).json()
  assert.equal(answers.bogus.choice, null)
})

await check('limits are enforced before anything is sent', async () => {
  const tooMany = {}
  for (let i = 0; i < 33; i++) tooMany[`q${i}`] = noulQuestion('Yes?')
  const cases = [
    request({ questions: tooMany }),
    request({ questions: { s: scoreQuestion('Rate it', Array.from({ length: 11 }, (_, i) => `level ${i}`)) } }),
    request({ questions: { c: choiceQuestion('Pick', { only: 'one option' }) } }),
    request({ state: 'x'.repeat(140000) }),
    request({ state: '' }),
  ]
  for (const body of cases) {
    const res = await post('/api/jev', body)
    assert.equal(res.status, 400, `expected a 400, got ${res.status}`)
  }
  assert.equal(vendorCalls.length, 0, 'an invalid request must never reach the vendor')
})

await check('no key → PROVIDER_UNAVAILABLE, and the vendor is never called', async () => {
  const key = process.env.JEV_API_KEY
  delete process.env.JEV_API_KEY
  try {
    const res = await post('/api/jev', request())
    assert.equal(res.status, 503)
    assert.equal((await res.json()).code, 'PROVIDER_UNAVAILABLE')
    assert.equal(vendorCalls.length, 0)
  } finally {
    process.env.JEV_API_KEY = key
  }
})

await check('a caller without the pipeline\'s internal key never reaches the vendor', async () => {
  let status = 0
  const res = { setHeader() {}, status(c) { status = c; return this }, json() { return this }, end() { return this } }
  await quiet(() => handler({ method: 'POST', headers: {}, body: request(), socket: { remoteAddress: '10.0.0.9' } }, res))
  assert.ok(status === 401 || status === 403, `expected 401/403, got ${status}`)
  assert.equal(vendorCalls.length, 0)
})

await check('a signed-in user is refused too — only the pipeline spends Jev quota', async () => {
  // The dev auth bypass stands in for a valid user session: it gets past
  // requireAuthenticatedUser without the internal key, which is exactly the caller the
  // internal-key gate exists to stop. Without that gate this reaches the vendor.
  const saved = { bypass: process.env.DEV_AUTH_BYPASS, node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV }
  process.env.DEV_AUTH_BYPASS = 'true'
  delete process.env.NODE_ENV
  delete process.env.VERCEL_ENV
  try {
    let status = 0
    const res = { setHeader() {}, status(c) { status = c; return this }, json() { return this }, end() { return this } }
    await quiet(() => handler({ method: 'POST', headers: { authorization: 'Bearer user-session' }, body: request(), socket: { remoteAddress: '10.0.0.8' } }, res))
    assert.equal(status, 403, `expected 403, got ${status}`)
    assert.equal(vendorCalls.length, 0)
  } finally {
    for (const [k, v] of [['DEV_AUTH_BYPASS', saved.bypass], ['NODE_ENV', saved.node], ['VERCEL_ENV', saved.vercel]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

await check('a vendor error becomes a 502, not a thrown exception', async () => {
  vendorMode = 'fail'
  const res = await post('/api/jev', request())
  assert.equal(res.status, 502)
})

console.log('\njev client')

const clientWith = (impl) => {
  let calls = 0
  const client = createJevClient({ post: async (...a) => { calls++; return impl(...a) }, endpoint: '/api/jev' })
  return { client, calls: () => calls }
}

await check('decide returns answers from the real gateway path', async () => {
  const client = createJevClient({ post, endpoint: '/api/jev' })
  const answers = await client.decide(request())
  assert.equal(pYes(answers.substantive), 0.83)
})

await check('any failure is null — decide never throws', async () => {
  for (const impl of [
    async () => { throw new Error('network down') },
    async () => ({ ok: false, status: 502, json: async () => ({ error: 'x' }) }),
    async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ nonsense: true }) }),
  ]) {
    const { client } = clientWith(impl)
    assert.equal(await client.decide(request()), null)
  }
})

await check('no key: the first PROVIDER_UNAVAILABLE stops all further calls', async () => {
  const { client, calls } = clientWith(async () => ({ ok: false, status: 503, json: async () => ({ code: 'PROVIDER_UNAVAILABLE' }) }))
  const out = await client.decideEach(Array.from({ length: 50 }), () => request(), { concurrency: 1 })
  assert.equal(calls(), 1, 'one round trip to learn there is no key, not fifty')
  assert.equal(out.answered, 0)
  assert.equal(out.skipped, 49)
  assert.ok(client.isUnavailable())
})

await check('a vendor that fails every call trips the breaker after one wave', async () => {
  const { client, calls } = clientWith(async () => ({ ok: false, status: 502, json: async () => ({}) }))
  const out = await client.decideEach(Array.from({ length: 200 }), () => request(), { concurrency: 8 })
  assert.ok(calls() <= 8 + 7, `made ${calls()} calls into a dead vendor`)
  assert.equal(out.answered, 0)
  assert.equal(out.failed + out.skipped, 200, 'every item is accounted for')
})

await check('decideEach stops issuing past its deadline and accounts for every item', async () => {
  vendorMode = 'slow'
  const client = createJevClient({ post, endpoint: '/api/jev' })
  const out = await client.decideEach(Array.from({ length: 40 }), () => request(), { concurrency: 2, deadlineMs: 200 })
  assert.ok(out.skipped > 0, 'items past the deadline must be skipped, not awaited')
  assert.equal(out.answered + out.failed + out.skipped, 40)
})

await check('decideEach resolves by its deadline even while calls hang, and ignores late answers', async () => {
  let release
  const hung = new Promise(r => { release = r })
  const client = createJevClient({
    post: async () => { await hung; return { ok: true, status: 200, headers: new Headers(), json: async () => ({ answers: { x: { type: 'noul', p: 1 } } }) } },
  })
  const t0 = Date.now()
  // Watchdog: without it, a regression here awaits a promise with no timer behind it, and
  // Node exits 0 mid-suite instead of failing.
  const out = await Promise.race([
    client.decideEach([1, 2, 3], () => request(), { concurrency: 3, deadlineMs: 100 }),
    new Promise((_, reject) => setTimeout(() => { release(); reject(new Error('decideEach never resolved while calls hung')) }, 2000)),
  ])
  const took = Date.now() - t0
  assert.ok(took < 1000, `a hung vendor held the step for ${took}ms past a 100ms deadline`)
  assert.equal(out.answered, 0)
  assert.equal(out.skipped, 3, 'in-flight at the deadline counts as skipped, not failed')
  release()
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(out.results, [null, null, null], 'an answer arriving after the deadline must not change what the caller holds')
})

await check('results line up with their items', async () => {
  const client = createJevClient({
    post: async (_u, body) => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ answers: { echo: { type: 'noul', p: Number(body.state) / 100 } } }),
    }),
  })
  const items = [5, 50, 95, 20]
  const out = await client.decideEach(items, (n) => ({ state: String(n), questions: { echo: noulQuestion('?') } }), { concurrency: 3 })
  assert.deepEqual(out.results.map(a => a.echo.p), [0.05, 0.5, 0.95, 0.2])
})

await check('a null build() skips the item rather than sending an empty request', async () => {
  const { client, calls } = clientWith(async () => ({ ok: true, headers: new Headers(), json: async () => ({ answers: {} }) }))
  const out = await client.decideEach([1, 2, 3], (n) => (n === 2 ? null : request()), { concurrency: 1 })
  assert.equal(calls(), 2)
  assert.equal(out.skipped, 1)
  assert.equal(out.results[1], null)
})

await check('mode defaults to shadow, reads per-use-case then global env, rejects junk', () => {
  const env = (vars) => (name) => vars[name] || ''
  assert.equal(jevMode('triage', env({})), 'shadow')
  assert.equal(jevMode('triage', env({ JEV_MODE: 'off' })), 'off')
  assert.equal(jevMode('triage', env({ JEV_MODE: 'off', JEV_TRIAGE: 'on' })), 'on')
  assert.equal(jevMode('triage', env({ JEV_TRIAGE: 'yes please' })), 'shadow')
})

await check('compact context keeps discriminating fields and stays small', () => {
  const out = compactContext({
    company_name: 'Acme', brand_voice: 'warm',
    _trackedEntities: Array.from({ length: 500 }, (_, i) => ({ name: `E${i}` })),
  })
  assert.match(out, /COMPANY: Acme/)
  assert.doesNotMatch(out, /warm/)
  assert.ok(out.length < 4000)
})

server.close()
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
