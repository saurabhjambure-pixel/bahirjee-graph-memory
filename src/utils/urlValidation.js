import { extractTargetDomain } from '../services/reportService.js';

// The intake form previously gated submit on `!urlInput` alone, so typing "asdf"
// started a full analysis run and consumed the founder's single free credit.
// Validation reuses extractTargetDomain so intake and persistence agree on what
// counts as a domain.

// Hosts that parse fine but are never a company website worth analysing.
const NON_PUBLIC_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;

/**
 * @param {string} raw - whatever the founder typed
 * @returns {{ ok: boolean, normalized: string|null, message: string|null }}
 */
export function validateWebsiteUrl(raw) {
    const trimmed = String(raw || '').trim();

    if (!trimmed) {
        return { ok: false, normalized: null, message: 'Enter your company website.' };
    }

    if (/\s/.test(trimmed)) {
        return { ok: false, normalized: null, message: "That doesn't look like a website address — remove any spaces." };
    }

    const domain = extractTargetDomain(trimmed);
    if (!domain) {
        return { ok: false, normalized: null, message: "That doesn't look like a website address. Try something like acme.com" };
    }

    if (NON_PUBLIC_HOSTS.test(domain)) {
        return { ok: false, normalized: null, message: 'Enter a public company website — local addresses cannot be analysed.' };
    }

    // extractTargetDomain returns bare hostnames for localhost/IPs; anything else
    // must have a dot and a plausible TLD to be a real site.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) || !/\.[a-z]{2,}$/i.test(domain)) {
        return { ok: false, normalized: null, message: "That doesn't look like a website address. Try something like acme.com" };
    }

    return {
        ok: true,
        normalized: trimmed.startsWith('http') ? trimmed : `https://${trimmed}`,
        message: null
    };
}
