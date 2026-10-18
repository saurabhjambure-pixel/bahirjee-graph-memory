
import { createClient } from '@supabase/supabase-js'
import { createFetchWithTimeout } from './fetchWithTimeout.js'

function readEnv(name) {
    const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env || {} : {}
    if (viteEnv[name]) return viteEnv[name]
    return readProcessEnv(name)
}

// Vite inlines `import.meta.env` as a literal object, so anything VITE_-prefixed is in the
// bundle whether or not it is read. Service-role keys are read from process.env only.
function readProcessEnv(name) {
    if (typeof process !== 'undefined' && process?.env?.[name]) return process.env[name]
    return ''
}

// This module is imported by services that run in both the browser and the intelligence
// worker (a Node serverless function). No SSR here, so `window` absence means the worker.
//
// The worker has no auth session, so an anon key cannot satisfy the auth.uid()-gated RLS
// policies on `reports`/`observations` — it must use the service role. The browser must
// never see the service role, so its key chain stops at anon.
const isServer = typeof window === 'undefined'

const supabaseUrl = readEnv('VITE_SUPABASE_URL') || readEnv('SUPABASE_URL')
const supabaseKey = isServer
    ? readProcessEnv('SUPABASE_SERVICE_ROLE_KEY') || readProcessEnv('VITE_SUPABASE_SERVICE_ROLE_KEY')
    : readEnv('VITE_SUPABASE_ANON_KEY') || readEnv('SUPABASE_ANON_KEY')

// Every request gets a timeout. This client is the one the pipeline writes through, and
// fetch has no default timeout — a stalled call in stepPersist otherwise hangs the job
// forever with no error and no heartbeat. See fetchWithTimeout.js.
export const supabase = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        global: { fetch: createFetchWithTimeout() }
    })
    : null

export const isSupabaseConfigured = () => !!supabase
