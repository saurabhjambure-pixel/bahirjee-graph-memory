/**
 * SUPABASE_URL must be the bare project origin.
 *
 * supabase-js appends `rest/v1`, `auth/v1`, … to whatever it is given, so a value copied
 * as the "REST endpoint" (https://<ref>.supabase.co/rest/v1) makes every query hit
 * /rest/v1/rest/v1/<table>. PostgREST answers PGRST125 "Invalid path specified in request
 * URL" — which is exactly what the live sign-in returned on 2026-10-18.
 *
 * Run: npm run test:supabase-url
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { normalizeSupabaseUrl } from '../src/lib/supabaseUrl.js'
import { resolveSupabaseUrl } from '../lib/_auth.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const ORIGIN = 'https://abcd1234.supabase.co'

// ─── The helper ─────────────────────────────────────────────────────────────

await check('a bare origin is returned unchanged', () => {
  assert.equal(normalizeSupabaseUrl(ORIGIN), ORIGIN)
})

await check('trailing slash, /rest/v1, /auth/v1 and whitespace are stripped to the origin', () => {
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/rest/v1`, `${ORIGIN}/rest/v1/`, `${ORIGIN}/auth/v1`, `  ${ORIGIN}/rest/v1  `]) {
    assert.equal(normalizeSupabaseUrl(url), ORIGIN, url)
  }
})

await check('a local or self-hosted origin keeps its port', () => {
  assert.equal(normalizeSupabaseUrl('http://127.0.0.1:54321/rest/v1'), 'http://127.0.0.1:54321')
})

await check('empty and unparseable values pass through so the "missing env" paths still fire', () => {
  assert.equal(normalizeSupabaseUrl(''), '')
  assert.equal(normalizeSupabaseUrl(undefined), '')
  assert.equal(normalizeSupabaseUrl('your_supabase_project_url_here'), 'your_supabase_project_url_here')
})

await check('resolveSupabaseUrl returns a normalized origin', () => {
  assert.equal(resolveSupabaseUrl({ serverUrl: `${ORIGIN}/rest/v1`, browserUrl: '' }), ORIGIN)
  assert.equal(resolveSupabaseUrl({ serverUrl: '', browserUrl: `${ORIGIN}/` }), ORIGIN)
})

// ─── End to end: the request path supabase-js actually sends ─────────────────

await check('a /rest/v1-suffixed URL, normalized, queries /rest/v1/<table> exactly once', async () => {
  const paths = []
  const srv = http.createServer((req, res) => {
    paths.push(req.url.split('?')[0])
    res.setHeader('content-type', 'application/json')
    res.end('null')
  }).listen(0, '127.0.0.1')
  await new Promise(r => srv.on('listening', r))
  try {
    const misconfigured = `http://127.0.0.1:${srv.address().port}/rest/v1`
    await createClient(normalizeSupabaseUrl(misconfigured), 'k').from('clients').select('id').maybeSingle()
    assert.deepEqual(paths, ['/rest/v1/clients'])
  } finally {
    srv.close()
  }
})

// ─── Every client construction goes through it ──────────────────────────────

await check('every createClient call site normalizes its URL', () => {
  const sites = {
    '../src/lib/supabase.js': /normalizeSupabaseUrl\(/,
    '../lib/_auth.js': /normalizeSupabaseUrl\(/,
    '../lib/handlers/auth-link.js': /normalizeSupabaseUrl\(/,
    '../lib/handlers/brief-access.js': /normalizeSupabaseUrl\(/,
  }
  for (const [file, pattern] of Object.entries(sites)) {
    assert.match(read(file), pattern, `${file} builds a Supabase client from a raw env URL`)
  }
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
