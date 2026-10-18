// --- HELPER FUNCTIONS ---

/**
 * Origins this deployment serves itself from.
 *
 * Vercel mints a NEW hostname for every branch deployment
 * (`<project>-git-<branch>-<scope>.vercel.app`), so a preview can never appear in a
 * hand-maintained ALLOWED_ORIGINS list. Without this, every preview 403s on every API call
 * with "Origin not allowed" and the app is untestable before it reaches production — which
 * is exactly what happened on the `agentic-implementation` preview.
 *
 * This is not a loosening of the policy. The browser only sends these Origin values when the
 * page making the request IS this deployment; it is same-origin by construction. What the
 * allowlist actually exists to stop — a third-party site calling these routes with a user's
 * cookies — is unaffected.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` and `VERCEL_URL` are auto-injected; `SITE_URL` is the manual
 * override already used by api/auth-link.js. Localhost values are ignored here because the
 * dev defaults below cover them with explicit ports.
 */
function selfOrigins() {
    const hosts = [
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL,
        process.env.VERCEL_BRANCH_URL,
        process.env.SITE_URL,
    ];

    const out = [];
    for (const raw of hosts) {
        const value = String(raw || '').trim();
        if (!value) continue;
        // These arrive bare ("app.vercel.app") except SITE_URL, which may carry a scheme.
        let host = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (!host || /^localhost$|^127\.0\.0\.1$|^\[?::1\]?$/i.test(host.split(':')[0])) continue;
        out.push(`https://${host}`);
    }
    return out;
}

export function parseAllowedOrigins() {
    const raw = process.env.ALLOWED_ORIGINS;
    const configured = raw
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : ['http://localhost:5173', 'http://127.0.0.1:5173'];

    // A deployment always trusts its own origin, whether or not anyone listed it.
    return [...new Set([...configured, ...selfOrigins()])];
}

/**
 * The host this request was actually served on, per the edge proxy.
 * `x-forwarded-host` is what Vercel sets; `host` is the direct fallback.
 */
function requestHost(req) {
    const forwarded = req?.headers?.['x-forwarded-host'];
    const host = (typeof forwarded === 'string' && forwarded) || req?.headers?.host || '';
    return String(host).split(',')[0].trim().toLowerCase();
}

/** True when `origin` names the same host this request arrived on. */
function isSameOrigin(origin, req) {
    const host = requestHost(req);
    if (!host || !origin) return false;
    try {
        return new URL(origin).host.toLowerCase() === host;
    } catch {
        return false;
    }
}

export function isOriginAllowed(origin, allowedOrigins, req = null) {
    if (!origin) return true; // Non-browser/server-to-server callers
    if (allowedOrigins.includes('*')) return true;
    if (allowedOrigins.includes(origin)) return true;

    // Same-origin is allowed unconditionally, and this is the check that actually makes
    // preview deployments work. Vercel serves a deployment on several hostnames — the
    // immutable deployment URL (VERCEL_URL), the branch alias (VERCEL_BRANCH_URL,
    // "<project>-git-<branch>-<scope>.vercel.app"), and any custom domain — and which env
    // vars are exposed at runtime is a project setting. Comparing the Origin against the host
    // the request actually arrived on needs no configuration and covers all of them.
    //
    // It is also not a widening: an Origin equal to our own Host means the page issuing the
    // request IS this deployment. The cross-site caller the allowlist exists to block sends a
    // different Origin, and still fails.
    return isSameOrigin(origin, req);
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

function setCorsHeaders(res, origin, allowedOrigins, allowHeaders, req = null) {
    if (origin && allowedOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && (allowedOrigins.includes(origin) || isSameOrigin(origin, req))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
}

// --- RATE LIMITING (In-Memory with optional Redis upgrade) ---

// Lazy-load Redis only if credentials exist to prevent import crashes
let redis = null;
let redisInitialized = false;

async function getRedis() {
    if (redisInitialized) return redis;
    redisInitialized = true;

    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (redisUrl && redisToken) {
        try {
            const { Redis } = await import('@upstash/redis');
            redis = new Redis({ url: redisUrl, token: redisToken });
            console.log('✅ Redis rate limiter initialized');
        } catch (e) {
            console.warn('⚠️ Failed to initialize Redis, using in-memory fallback:', e.message);
            redis = null;
        }
    } else {
        console.warn("⚠️ Rate limiting: Upstash Redis not configured. Using in-memory fallback.");
    }

    return redis;
}

// Fallback in-memory store for dev or missing envs
const rateLimitStore = new Map();

async function checkRateLimit(req, routeKey, maxRequests, windowMs) {
    const ip = getClientIp(req);
    const now = Date.now();
    const key = `ratelimit:${routeKey}:${ip}`;

    const redisClient = await getRedis();

    if (redisClient) {
        try {
            const pipeline = redisClient.pipeline();
            pipeline.incr(key);
            pipeline.pttl(key);
            const [count, ttl] = await pipeline.exec();

            if (count === 1 || ttl < 0) {
                await redisClient.pexpire(key, windowMs);
            }

            const windowSeconds = Math.ceil(windowMs / 1000);
            const remaining = Math.max(maxRequests - count, 0);
            const resetSeconds = count === 1 ? windowSeconds : Math.ceil(Math.abs(ttl) / 1000);

            return {
                limited: count > maxRequests,
                retryAfterSec: resetSeconds,
                count,
                remaining,
                resetAtMs: now + (resetSeconds * 1000)
            };
        } catch (error) {
            console.error("Redis rate limit error, falling back to bypass:", error.message);
            return { limited: false, count: 1, remaining: maxRequests, resetAtMs: now + windowMs };
        }
    }

    // --- FALLBACK IN-MEMORY LOGIC ---
    const row = rateLimitStore.get(key);

    if (!row || now - row.windowStart >= windowMs) {
        rateLimitStore.set(key, { count: 1, windowStart: now });
        return {
            limited: false,
            count: 1,
            remaining: Math.max(maxRequests - 1, 0),
            resetAtMs: now + windowMs
        };
    }

    if (row.count >= maxRequests) {
        const retryAfterMs = windowMs - (now - row.windowStart);
        return {
            limited: true,
            retryAfterSec: Math.ceil(retryAfterMs / 1000),
            count: row.count,
            remaining: 0,
            resetAtMs: row.windowStart + windowMs
        };
    }

    row.count += 1;
    rateLimitStore.set(key, row);

    if (rateLimitStore.size > 1000) {
        for (const [k, v] of rateLimitStore) {
            if (now - v.windowStart > windowMs) rateLimitStore.delete(k);
        }
    }

    return {
        limited: false,
        count: row.count,
        remaining: Math.max(maxRequests - row.count, 0),
        resetAtMs: row.windowStart + windowMs
    };
}

// --- MAIN EXPORTED FUNCTION ---

export async function applyApiSecurity(req, res, {
    routeKey,
    allowedMethods = ['POST'],
    allowHeaders = ['Content-Type', 'Authorization'],
    maxRequests = Number(process.env.API_RATE_LIMIT_MAX || 60),
    windowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000)
}) {
    const origin = req.headers.origin;
    const allowedOrigins = parseAllowedOrigins();

    if (!isOriginAllowed(origin, allowedOrigins, req)) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }

    setCorsHeaders(res, origin, allowedOrigins, allowHeaders, req);

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true;
    }

    if (!allowedMethods.includes(req.method)) {
        res.status(405).json({ error: 'Method not allowed' });
        return true;
    }

    const rl = await checkRateLimit(req, routeKey, maxRequests, windowMs);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetAtMs / 1000)));

    if (rl.limited) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        return true;
    }

    return false;
}
