import assert from 'node:assert/strict'
import { fetchWithAuth } from '../src/services/apiClient.js'
import { getSupabaseAdminConfig } from '../lib/_auth.js'

const response = (status, body = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

{
  const calls = []
  let unauthorizedCalls = 0
  const result = await fetchWithAuth('/api/intelligence', { method: 'POST' }, {
    getToken: async () => 'expired-token',
    refreshToken: async () => 'fresh-token',
    onUnauthorized: async () => { unauthorizedCalls += 1 },
    fetchImpl: async (_url, options) => {
      calls.push(options.headers.get('Authorization'))
      return calls.length === 1 ? response(401) : response(200, { ok: true })
    },
  })

  assert.equal(result.status, 200, 'a 401 should be retried after refreshing the session')
  assert.deepEqual(calls, ['Bearer expired-token', 'Bearer fresh-token'])
  assert.equal(unauthorizedCalls, 0, 'a successful refresh must not sign the user out')
}

{
  let refreshCalls = 0
  let unauthorizedCalls = 0
  const result = await fetchWithAuth('/api/intelligence', {}, {
    getToken: async () => 'expired-token',
    refreshToken: async () => { refreshCalls += 1; return null },
    onUnauthorized: async () => { unauthorizedCalls += 1 },
    fetchImpl: async () => response(401),
  })

  assert.equal(result.status, 401)
  assert.equal(refreshCalls, 1)
  assert.equal(unauthorizedCalls, 1, 'logout should happen only after refresh fails')
}

{
  const saved = { ...process.env }
  const payload = Buffer.from(JSON.stringify({ ref: 'correct-project' })).toString('base64url')
  process.env.SUPABASE_URL = 'https://stale-project.supabase.co'
  process.env.VITE_SUPABASE_URL = 'https://correct-project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = `header.${payload}.signature`

  const config = getSupabaseAdminConfig()
  assert.equal(
    config.supabaseUrl,
    'https://correct-project.supabase.co',
    'server auth must use the URL belonging to the service-role key when the two URL env vars differ'
  )

  process.env = saved
}

console.log('api client auth tests passed')
