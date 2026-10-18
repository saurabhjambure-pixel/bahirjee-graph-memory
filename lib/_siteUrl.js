// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WHERE THIS DEPLOYMENT LIVES
//
// Three callers need the absolute origin of the running app and each had grown its own
// answer: `_security.js` builds self-origins for CORS, `auth-link.js` builds a magic-link
// returnTo, and the Monday Letter needs an absolute URL because a link in an inbox has no
// relative base to resolve against.
//
// A link that resolves to the wrong deployment is not a cosmetic bug in a letter: it is a
// sign-in that dead-ends, or an "evidence" link pointing at a preview build. Three
// independent priority chains would drift; this is one.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const LOCAL_FALLBACK = 'http://localhost:5173';

/** A value that would send a production email to someone's laptop. */
export function isLocalOrigin(url) {
    return !url || /localhost|127\.0\.0\.1|\[?::1\]?/i.test(String(url));
}

function withScheme(host) {
    const value = String(host || '').trim();
    if (!value) return null;
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * The origin this deployment is reachable at, without a trailing slash.
 *
 * Priority, highest first:
 *   1. SITE_URL                        — manual override, ignored when it points at localhost
 *   2. VERCEL_PROJECT_PRODUCTION_URL   — auto-injected, the fixed production domain
 *   3. VERCEL_URL                      — auto-injected, this specific deployment
 *   4. requestOrigin                   — the caller's own Origin header, when it has one and
 *                                        it is not localhost. Background work (cron, the
 *                                        worker) has no request, which is exactly why this
 *                                        is a parameter rather than something read here.
 *   5. localhost, for local dev
 *
 * @param {{requestOrigin?: string, allowLocal?: boolean}} [options]
 *        `allowLocal: false` returns null instead of the localhost fallback — use it where
 *        a wrong link is worse than no link, such as an email that is about to be sent.
 */
export function resolveSiteOrigin({ requestOrigin = '', allowLocal = true } = {}) {
    const candidates = [
        isLocalOrigin(process.env.SITE_URL) ? null : withScheme(process.env.SITE_URL),
        withScheme(process.env.VERCEL_PROJECT_PRODUCTION_URL),
        withScheme(process.env.VERCEL_URL),
        isLocalOrigin(requestOrigin) ? null : withScheme(requestOrigin),
    ];

    const resolved = candidates.find(Boolean);
    if (resolved) return resolved.replace(/\/+$/, '');
    return allowLocal ? LOCAL_FALLBACK : null;
}

/**
 * An absolute URL to a path within the app, or null when the origin cannot be resolved
 * safely.
 *
 * Returns null rather than a localhost URL by default: this exists for links that leave
 * the building, and "http://localhost:5173/read" in a founder's inbox is worse than a
 * letter with no button on it.
 */
export function absoluteUrl(path, { requestOrigin = '', allowLocal = false } = {}) {
    const origin = resolveSiteOrigin({ requestOrigin, allowLocal });
    if (!origin) return null;
    const suffix = String(path || '').replace(/^\/+/, '');
    return suffix ? `${origin}/${suffix}` : origin;
}
