// Node's fetch (and the browser's) has NO default timeout. supabase-js builds on fetch,
// so a stalled PostgREST request hangs forever. In production Vercel's 60s function cap
// eventually kills it; locally nothing does — which is how a completed-in-5-minutes run
// could sit at "Saving report" indefinitely with no error and no heartbeat.
//
// stepPersist alone makes ~8 sequential Supabase calls with no cursor and no defer, so it
// must finish inside one invocation. A single stalled call there strands the whole job.
//
// Default 20s: comfortably above a large JSONB report insert, comfortably below the
// worker's STEP_MAX_MS (45s) so a hung call surfaces as a step error while the step still
// has budget to fail cleanly, rather than being killed mid-write.
const DEFAULT_TIMEOUT_MS = 20_000;

function readTimeout() {
    const raw =
        (typeof process !== 'undefined' && process?.env?.SUPABASE_FETCH_TIMEOUT_MS) || '';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * A fetch wrapper that aborts after `timeoutMs`, for handing to
 * createClient(url, key, { global: { fetch: createFetchWithTimeout() } }).
 *
 * Uses AbortController + setTimeout rather than AbortSignal.timeout() for wider runtime
 * support, and chains any caller-supplied signal so supabase-js's own aborts still work.
 */
export function createFetchWithTimeout(timeoutMs = readTimeout()) {
    return async function fetchWithTimeout(input, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        // Respect a signal the caller already passed instead of silently dropping it.
        if (init.signal) {
            if (init.signal.aborted) controller.abort();
            else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            return await fetch(input, { ...init, signal: controller.signal });
        } catch (err) {
            // Surface a message that names the cause. A bare "AbortError" in a log is
            // indistinguishable from a cancelled request and sent us hunting the wrong bug.
            if (err?.name === 'AbortError' && !init.signal?.aborted) {
                const url = typeof input === 'string' ? input : input?.url || '';
                const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
                throw new Error(`Supabase request timed out after ${timeoutMs}ms: ${path}`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    };
}
