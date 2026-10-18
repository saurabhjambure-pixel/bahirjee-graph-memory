import { createClient } from '@supabase/supabase-js';
import { createFetchWithTimeout } from '../src/lib/fetchWithTimeout.js';
import { normalizeSupabaseUrl } from '../src/lib/supabaseUrl.js';

function getEnv(name, fallback = '') {
    return process.env[name] || fallback;
}

function projectRefFromUrl(url) {
    try {
        const host = new URL(url).hostname;
        return host.match(/^([^.]+)\.supabase\.co$/i)?.[1] || null;
    } catch {
        return null;
    }
}

function projectRefFromJwt(key) {
    try {
        const payload = key.split('.')[1];
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).ref || null;
    } catch {
        return null;
    }
}

export function resolveSupabaseUrl({ serverUrl, browserUrl, serviceRoleKey }) {
    const keyRef = projectRefFromJwt(serviceRoleKey || '');
    if (keyRef) {
        const matchingUrl = [serverUrl, browserUrl]
            .filter(Boolean)
            .find(url => projectRefFromUrl(url) === keyRef);
        if (matchingUrl) return normalizeSupabaseUrl(matchingUrl);
    }
    return normalizeSupabaseUrl(serverUrl || browserUrl);
}

export function getSupabaseAdminConfig() {
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    // The browser's JWT is minted by VITE_SUPABASE_URL. If a stale SUPABASE_URL is
    // still present in a preview environment, prefer the candidate that belongs to the
    // service-role key so the server does not validate that JWT against another project.
    const supabaseUrl = resolveSupabaseUrl({
        serverUrl: getEnv('SUPABASE_URL'),
        browserUrl: getEnv('VITE_SUPABASE_URL'),
        serviceRoleKey,
    });
    const anonKey = getEnv('SUPABASE_ANON_KEY', getEnv('VITE_SUPABASE_ANON_KEY'));
    const missing = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL / VITE_SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_SERVICE_ROLE_KEY');
    return { supabaseUrl, serviceRoleKey, anonKey, missing };
}

export function getSupabaseAdmin() {
    const { supabaseUrl, serviceRoleKey, missing } = getSupabaseAdminConfig();
    if (missing.length) {
        throw new Error(`Supabase admin env not configured. Missing ${missing.join(', ')}`);
    }
    // Timed-out fetch: this client backs the job/worker writes, and a stalled request
    // would otherwise hang an invocation with no error. See src/lib/fetchWithTimeout.js.
    return createClient(supabaseUrl, serviceRoleKey, {
        global: { fetch: createFetchWithTimeout() }
    });
}

export function getBearerToken(req) {
    const header = req.headers?.authorization || req.headers?.Authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length).trim();
}

export function hasValidInternalApiKey(req) {
    const provided = req.headers?.['x-bahirjee-internal-key'] || req.headers?.['X-Bahirjee-Internal-Key'];
    // Prefer a dedicated internal secret; fall back to the service-role key only if
    // INTERNAL_API_KEY isn't configured yet (transitional — set INTERNAL_API_KEY in prod).
    const expected = getEnv('INTERNAL_API_KEY')
        || getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    return Boolean(provided && expected && provided === expected);
}

const authenticatedRateLimitStore = new Map();

function checkAuthenticatedRateLimit({ routeKey, userId, clientId, maxRequests = 30, windowMs = 60_000 }) {
    const now = Date.now();
    const key = `authlimit:${routeKey}:${clientId || 'no-client'}:${userId}`;
    const row = authenticatedRateLimitStore.get(key);

    if (!row || now - row.windowStart >= windowMs) {
        authenticatedRateLimitStore.set(key, { count: 1, windowStart: now });
        return {
            limited: false,
            remaining: Math.max(maxRequests - 1, 0),
            resetAtMs: now + windowMs
        };
    }

    if (row.count >= maxRequests) {
        return {
            limited: true,
            remaining: 0,
            resetAtMs: row.windowStart + windowMs,
            retryAfterSec: Math.ceil((windowMs - (now - row.windowStart)) / 1000)
        };
    }

    row.count += 1;
    authenticatedRateLimitStore.set(key, row);

    if (authenticatedRateLimitStore.size > 2000) {
        for (const [k, v] of authenticatedRateLimitStore) {
            if (now - v.windowStart > windowMs) authenticatedRateLimitStore.delete(k);
        }
    }

    return {
        limited: false,
        remaining: Math.max(maxRequests - row.count, 0),
        resetAtMs: row.windowStart + windowMs
    };
}

export async function requireAuthenticatedUser(req, res, options = {}) {
    const { requireAdmin = false, rateLimit = null } = options;

    let supabaseAdmin;
    try {
        supabaseAdmin = getSupabaseAdmin();
    } catch (error) {
        res.status(500).json({ error: error.message });
        return null;
    }

    // ── LOCAL DEV ONLY: complete auth bypass ──────────────────────────────
    // Active only when DEV_AUTH_BYPASS=true AND this is NOT a production deploy.
    // Guarded by BOTH NODE_ENV and VERCEL_ENV so a non-'production' NODE_ENV
    // (e.g. 'staging', or unset) on a real Vercel deploy still can't open the
    // bypass — Vercel sets VERCEL_ENV=production for production deployments.
    if (
        process.env.NODE_ENV !== 'production' &&
        process.env.VERCEL_ENV !== 'production' &&
        process.env.DEV_AUTH_BYPASS === 'true'
    ) {
        console.warn('[DEV] Auth bypass active — treating request as mock admin.');
        return {
            user: { id: '00000000-0000-0000-0000-0000000000de', email: 'dev@bahirjee.local' },
            profile: {
                id: '00000000-0000-0000-0000-0000000000de',
                role: process.env.DEV_BYPASS_ROLE || 'client_user',
                client_id: process.env.DEV_BYPASS_CLIENT_ID || null,
                is_active: true,
                is_premium: true,
                run_count: 0,
                client: null
            },
            supabaseAdmin,
            token: 'dev-bypass'
        };
    }

    if (hasValidInternalApiKey(req)) {
        return {
            user: { id: 'internal-job-runner', email: 'internal@bahirjee.local' },
            profile: {
                id: 'internal-job-runner',
                role: 'admin',
                client_id: null,
                is_active: true,
                is_premium: true,
                run_count: 0,
                client: null
            },
            supabaseAdmin,
            token: 'internal-job-runner'
        };
    }

    const token = getBearerToken(req);
    if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) {
        res.status(401).json({ error: 'Invalid access token' });
        return null;
    }

    const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select(`
            id,
            role,
            client_id,
            is_active,
            is_premium,
            run_count,
            clients(id, name, domain, exempt_from_freemium)
        `)
        .eq('id', authData.user.id)
        .single();

    if (profileError || !profile) {
        res.status(403).json({ error: 'Profile not found' });
        return null;
    }

    if (profile.is_active === false) {
        res.status(403).json({ error: 'User is inactive' });
        return null;
    }

    if (requireAdmin && profile.role !== 'admin') {
        res.status(403).json({ error: 'Admin permission required' });
        return null;
    }

    const client = profile.clients || null;
    delete profile.clients;

    if (rateLimit) {
        const rl = checkAuthenticatedRateLimit({
            routeKey: rateLimit.routeKey || 'authenticated',
            userId: authData.user.id,
            clientId: profile.client_id,
            maxRequests: rateLimit.maxRequests,
            windowMs: rateLimit.windowMs
        });
        res.setHeader('X-UserRateLimit-Remaining', String(rl.remaining));
        res.setHeader('X-UserRateLimit-Reset', String(Math.ceil(rl.resetAtMs / 1000)));
        if (rl.limited) {
            res.setHeader('Retry-After', String(rl.retryAfterSec));
            res.status(429).json({ error: 'User rate limit exceeded. Try again later.' });
            return null;
        }
    }

    return {
        user: authData.user,
        profile: { ...profile, client },
        supabaseAdmin,
        token
    };
}
