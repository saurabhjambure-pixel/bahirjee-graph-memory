import assert from 'node:assert/strict'
import { resolveRouteHandler } from '../api/router.js'

const cases = ['gemini', 'search', 'jev', 'sarvam', 'intelligence-worker', 'auth-link', 'cron-runs']

for (const route of cases) {
  const handler = await resolveRouteHandler(route)
  assert.equal(typeof handler, 'function', `Expected a handler function for ${route}`)
}

console.log('router dispatch test passed')
