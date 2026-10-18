/**
 * Observation write fallback — a source_type that ships before its migration.
 *
 * v27 adds 'exa_extract' to the observations.source_type CHECK. v22 and v23 both warn what
 * happens when code emitting a new value deploys before the migration: Postgres rejects the
 * row with 23514, rejects the WHOLE batch with it, storeObservations counts the error and
 * returns normally, and the stepped pipeline — which reads observations back from Postgres —
 * analyzes a thinner run with no error anywhere. A run's deep reads are written as one
 * batch, so one Exa-fallback read would take every Parallel AI read down with it.
 *
 * v24 was written and left unapplied, so "migration first" is not a safe assumption here.
 * The write path therefore relabels 'exa_extract' to its pre-v27 'exa' when the CHECK
 * rejects it. These tests drive the REAL storeObservations through the real supabase-js
 * client against a fake PostgREST whose CHECK the test controls — a source assertion could
 * not tell whether the retry actually happens, or whether the error code is read right.
 *
 * Run: npm run test:observation-write
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const PRE_V27 = ['tavily', 'firecrawl', 'exa', 'source_watch', 'connector', 'parallel_ai']
let permitted = new Set([...PRE_V27, 'exa_extract'])
let requests = []

const checkViolation = (constraint) => JSON.stringify({
  code: '23514',
  details: 'Failing row contains (...).',
  hint: null,
  message: `new row for relation "observations" violates check constraint "${constraint}"`,
})

const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const rows = body ? JSON.parse(body) : []
    requests.push(rows)
    let failure = null
    if (rows.some(r => String(r.source_url).includes('violates-another-check'))) failure = 'observations_other_check'
    else if (rows.some(r => !permitted.has(r.source_type))) failure = 'observations_source_type_check'
    if (failure) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(checkViolation(failure))
      return
    }
    res.writeHead(201)
    res.end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

// The client reads these at import time, so they must be set before the dynamic import.
delete process.env.VITE_SUPABASE_URL
process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
const { storeObservations } = await import('../src/services/observationService.js')

const warnings = []
const quiet = async (fn) => {
  const { log, warn, error } = console
  console.log = () => {}
  console.error = () => {}
  console.warn = (...a) => warnings.push(a.join(' '))
  try { return await fn() } finally { Object.assign(console, { log, warn, error }) }
}

const read = (url, source_type) => ({
  url, source_type, isDeepRead: true, title: 'Report', theme: 'research', job: 'q',
  data: 'full page text '.repeat(80),
})
const store = (rows) => quiet(() => storeObservations({ companyId: 'c1', runId: 'run-0001', rawResults: rows }))
const types = (i) => requests[i].map(r => r.source_type).sort()

let passed = 0
const check = async (name, fn) => {
  requests = []
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

console.log('\nobservation write fallback')

await check('with v27 applied, an Exa read is stored as exa_extract in one request', async () => {
  const result = await store([read('https://a.test/1', 'parallel_ai'), read('https://a.test/2', 'exa_extract')])
  assert.deepEqual({ stored: result.stored, errors: result.errors }, { stored: 2, errors: 0 })
  assert.equal(requests.length, 1, 'no retry when the database accepts the label')
  assert.deepEqual(types(0), ['exa_extract', 'parallel_ai'])
})

await check('an unrelated CHECK violation does not switch the label off', async () => {
  const result = await store([read('https://violates-another-check.test/1', 'parallel_ai'), read('https://b.test/2', 'exa_extract')])
  assert.equal(result.stored, 0, 'the batch genuinely failed and must be reported as failed')
  assert.equal(result.errors, 2)
  requests = []
  await store([read('https://b.test/3', 'exa_extract')])
  assert.equal(requests.length, 1)
  assert.deepEqual(types(0), ['exa_extract'], 'a 23514 the relabel did not fix says nothing about v27')
})

permitted = new Set(PRE_V27)

await check('without v27, the batch is retried under the pre-v27 label and nothing is lost', async () => {
  const result = await store([read('https://c.test/1', 'parallel_ai'), read('https://c.test/2', 'exa_extract')])
  assert.deepEqual(
    { stored: result.stored, errors: result.errors }, { stored: 2, errors: 0 },
    'the Parallel AI read must not be lost because its neighbour carried a new label'
  )
  assert.equal(requests.length, 2, 'one rejected attempt, one relabelled retry')
  assert.deepEqual(types(1), ['exa', 'parallel_ai'])
  assert.ok(warnings.some(w => w.includes('v28_exa_extract_source_type.sql')), 'the warning must name the migration to run')
})

await check('once v27 is known to be missing, later writes skip the failing round trip', async () => {
  const before = warnings.length
  const result = await store([read('https://d.test/1', 'exa_extract')])
  assert.equal(result.stored, 1)
  assert.equal(requests.length, 1, 'no second rejected attempt per write')
  assert.deepEqual(types(0), ['exa'])
  assert.equal(warnings.length, before, 'warn once per process, not once per batch')
})

server.close()
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
