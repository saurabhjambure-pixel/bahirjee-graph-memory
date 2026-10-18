import { supabase } from '../lib/supabase.js';

// LOCAL DEV ONLY: dead code in a production build (import.meta.env.DEV is false there).
// This module is imported transitively by the intelligence worker, which runs under a Node
// serverless runtime where `import.meta.env` is undefined — read it defensively, matching
// the guard in intelligenceService.js / supabase.js, so the worker module can load there.
const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env || {} : {};
const DEV_AUTH_BYPASS = viteEnv.DEV && viteEnv.VITE_DEV_AUTH_BYPASS === 'true';

export async function getAccessToken() {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error('No active session');
    return token;
}

export async function refreshAccessToken() {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) return null;
        return data?.session?.access_token || null;
    } catch {
        return null;
    }
}

// Redirect target when the session is gone.
function loginPathForCurrentArea() {
    return '/';
}

async function handleUnauthorized() {
    if (DEV_AUTH_BYPASS || typeof window === 'undefined') return;
    try {
        if (supabase) await supabase.auth.signOut();
    } catch {
        // ignore — we're redirecting to login regardless
    }
    const dest = loginPathForCurrentArea();
    if (window.location.pathname !== dest) {
        window.location.assign(dest);
    }
}

export async function fetchWithAuth(url, options = {}, deps = {}) {
    const getToken = deps.getToken || getAccessToken;
    const refreshToken = deps.refreshToken || refreshAccessToken;
    const onUnauthorized = deps.onUnauthorized || handleUnauthorized;
    const fetchImpl = deps.fetchImpl || fetch;
    const baseHeaders = new Headers(options.headers || {});

    const send = async (token) => {
        const headers = new Headers(baseHeaders);
        headers.set('Authorization', `Bearer ${token}`);
        return fetchImpl(url, { ...options, headers });
    };

    const token = await getToken();
    let response = await send(token);

    // Supabase can return a cached JWT just as it expires while the user is moving
    // through the multi-step intake flow. Refresh once before treating the 401 as a
    // real logout. The first request is rejected by auth before any intelligence job
    // side effect, so retrying this authenticated POST is safe.
    if (response.status === 401) {
        const freshToken = await refreshToken();
        if (freshToken) response = await send(freshToken);
        if (response.status === 401) await onUnauthorized();
    }

    return response;
}

export async function authenticatedFetch(url, options = {}) {
    if (DEV_AUTH_BYPASS) {
        // No session in bypass mode — the server accepts the request as mock admin.
        const headers = new Headers(options.headers || {});
        headers.set('x-dev-auth-bypass', '1');
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) await handleUnauthorized();
        return response;
    }

    return fetchWithAuth(url, options);
}

export async function postJson(url, body, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    return authenticatedFetch(url, {
        ...options,
        method: options.method || 'POST',
        headers,
        body: JSON.stringify(body)
    });
}
