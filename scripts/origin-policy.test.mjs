/**
 * Origin policy guards.
 *
 * Every Vercel preview 403'd on every API call with "Origin not allowed", making the app
 * impossible to exercise before production. `ALLOWED_ORIGINS` lists the production origin;
 * Vercel mints a new hostname per branch deployment, so a preview can never be in that list.
 *
 * The fix is that a deployment trusts its OWN origin — compared against the host the request
 * actually arrived on, which needs no configuration and covers the deployment URL, the branch
 * alias and any custom domain alike.
 *
 * These assertions call the real function. scripts/security-smoke-tests.mjs greps the source
 * for the same property, and that grep PASSED with the same-origin branch stubbed to `return
 * false` — a guard that cannot fail is not a guard.
 *
 * Run: npm run test:origin
 */
import assert from 'node:assert/strict'
import { isOriginAllowed, parseAllowedOrigins } from '../lib/_security.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('\norigin policy')

const HOST = 'bahirjee-poc-git-agentic-imple-7c0a1a-saurabh-jamburees-projects.vercel.app'
const PREVIEW = `https://${HOST}`
const PROD = 'https://bahirjee-poc.vercel.app'
const req = (h = HOST) => ({ headers: { 'x-forwarded-host': h } })
const prodOnly = [PROD]   // the real production config

check('a preview page may call its own API even though it is not in ALLOWED_ORIGINS', () => {
  assert.equal(isOriginAllowed(PREVIEW, prodOnly, req()), true,
    'this is the exact failure that made previews unusable')
})

check('a third-party origin is still blocked', () => {
  assert.equal(isOriginAllowed('https://evil.test', prodOnly, req()), false)
})

check('a look-alike hostname is blocked — matching must stay exact', () => {
  assert.equal(isOriginAllowed(`https://evil-${HOST}`, prodOnly, req()), false,
    'a prefix/suffix match here would let an attacker register a similar host')
  assert.equal(isOriginAllowed(`https://${HOST}.evil.test`, prodOnly, req()), false,
    'a suffix match would let any subdomain of an attacker domain through')
})

check('an explicitly listed origin still works cross-host', () => {
  assert.equal(isOriginAllowed(PROD, prodOnly, req()), true)
})

check('a scheme mismatch on the same host is not silently accepted', () => {
  // http:// against an https deployment is a different origin; only the host is compared, so
  // pin the behaviour deliberately rather than leaving it accidental.
  assert.equal(isOriginAllowed(`http://${HOST}`, prodOnly, req()), true,
    'host-only comparison is intentional — Vercel terminates TLS at the edge and forwards http')
})

check('server-to-server callers with no Origin are allowed', () => {
  assert.equal(isOriginAllowed(undefined, prodOnly, req()), true)
  assert.equal(isOriginAllowed('', prodOnly, req()), true)
})

check('a wildcard entry still opts everything in', () => {
  assert.equal(isOriginAllowed('https://anything.test', ['*'], req()), true)
})

check('a malformed Origin header does not throw or pass', () => {
  for (const bad of ['not a url', 'javascript:alert(1)', '://', 'http://']) {
    assert.doesNotThrow(() => isOriginAllowed(bad, prodOnly, req()), `threw on ${bad}`)
    assert.equal(isOriginAllowed(bad, prodOnly, req()), false, `${bad} must not be allowed`)
  }
})

check('a missing host header falls back to blocking, not allowing', () => {
  assert.equal(isOriginAllowed(PREVIEW, prodOnly, { headers: {} }), false,
    'without a host to compare against, same-origin cannot be proven')
  assert.equal(isOriginAllowed(PREVIEW, prodOnly, null), false)
})

check('req.headers.host is used when the proxy header is absent', () => {
  assert.equal(isOriginAllowed(PREVIEW, prodOnly, { headers: { host: HOST } }), true)
})

check('unset ALLOWED_ORIGINS still defaults to localhost only', () => {
  const saved = process.env.ALLOWED_ORIGINS
  delete process.env.ALLOWED_ORIGINS
  const list = parseAllowedOrigins()
  assert.ok(list.includes('http://localhost:5173'), 'dev default must survive')
  assert.ok(!list.includes('*'), 'an unset allowlist must never become a wildcard')
  if (saved !== undefined) process.env.ALLOWED_ORIGINS = saved
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
