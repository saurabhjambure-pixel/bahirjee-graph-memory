/**
 * Domains that must not become a self-serve workspace.
 *
 * ⚠️  READ THIS BEFORE EDITING.
 *
 * A self-serve signup creates ONE workspace per email domain, and everyone who later
 * signs up at that domain joins it. The reports RLS policy is
 *     client_id in (select client_id from public.profiles where id = auth.uid())
 * so workspace members can read each other's briefs. For colleagues at a real company
 * that is the point. For any domain that pools unrelated strangers it is a leak of
 * private strategic questions.
 *
 * That makes this list do security work, and it cannot be complete — new providers and
 * regional mail hosts appear faster than anyone maintains a list. It is a mitigation,
 * not a guarantee; `clients.member_cap` bounds the damage when something slips through.
 * If you are adding a feature that widens what a workspace member can see, do not lean
 * on this file to hold the line.
 *
 * Three categories, all rejected:
 *   1. Consumer mail — a personal address is not a company.
 *   2. Disposable mail — free unlimited runs to anyone with a browser.
 *   3. Academic and other shared TLDs — the highest-risk pooling case. Every student and
 *      staff member at a university shares one domain, and they are not one company.
 */

// 1. Consumer mail providers.
const CONSUMER_MAIL = new Set([
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com',
    'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com', 'live.co.uk', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com',
    'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
    'gmx.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch',
    'mail.com', 'email.com', 'usa.com',
    'yandex.com', 'yandex.ru', 'ya.ru',
    'zoho.com', 'zohomail.com',
    'hey.com', 'fastmail.com', 'fastmail.fm', 'tutanota.com', 'tuta.io',
    'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net',
    'rediffmail.com', 'rediff.com',
    'web.de', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 'seznam.cz',
    'bol.com.br', 'uol.com.br', 'terra.com.br',
]);

// 2. Disposable / throwaway mail. These would hand out unlimited free runs.
const DISPOSABLE_MAIL = new Set([
    'mailinator.com', 'yopmail.com', 'sharklasers.com', 'guerrillamail.com', 'guerrillamail.info',
    '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'tempmail.dev',
    'trashmail.com', 'throwawaymail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
    'fakeinbox.com', 'mailnesia.com', 'mintemail.com', 'spamgourmet.com', 'mohmal.com',
    'moakt.com', 'emailondeck.com', 'burnermail.io', 'inboxkitten.com', 'harakirimail.com',
]);

/**
 * 3. Shared-institution suffixes. Matched as suffixes rather than exact domains, because
 * these describe whole namespaces: mit.edu, ox.ac.uk, iitb.ac.in, unimelb.edu.au.
 *
 * `.gov` and `.mil` are here for a different reason — those are large, unrelated agencies
 * that should never be auto-pooled, and they are also not the beta audience.
 */
const SHARED_TLD_SUFFIXES = [
    '.edu', '.ac.uk', '.ac.in', '.ac.jp', '.ac.nz', '.ac.za', '.ac.kr', '.ac.at', '.ac.be',
    '.edu.au', '.edu.in', '.edu.sg', '.edu.cn', '.edu.hk', '.edu.my', '.edu.pk', '.edu.br',
    '.edu.mx', '.edu.tr', '.edu.pl', '.edu.co', '.edu.ar',
    '.gov', '.gov.uk', '.gov.in', '.gov.au', '.mil',
    '.k12.us', '.sch.uk', '.school.nz',
];

function envDomainSet(name) {
    return new Set(
        String(process.env[name] || '')
            .split(',')
            .map(value => value.trim().toLowerCase())
            .filter(Boolean)
    );
}

/**
 * Whether `domain` may be turned into (or joined to) a self-serve workspace.
 *
 * Returns `{ allowed, reason }`. `reason` is a stable machine code, never user copy —
 * the UI owns the wording.
 *
 * Env overrides:
 *   SELF_SERVE_ALLOW_DOMAINS   — bypass every check below. For testers on personal
 *                                addresses during the beta. Checked first.
 *   SELF_SERVE_BLOCKED_DOMAINS — extra exact-match denials, so a domain can be shut off
 *                                without a deploy.
 */
export function classifySelfServeDomain(rawDomain) {
    const domain = String(rawDomain || '').trim().toLowerCase().replace(/^@/, '');

    if (!domain || !domain.includes('.') || /\s/.test(domain)) {
        return { allowed: false, reason: 'invalid_domain' };
    }

    // The escape hatch runs first so a tester on gmail can always be let through.
    if (envDomainSet('SELF_SERVE_ALLOW_DOMAINS').has(domain)) {
        return { allowed: true, reason: 'explicitly_allowed' };
    }

    if (envDomainSet('SELF_SERVE_BLOCKED_DOMAINS').has(domain)) {
        return { allowed: false, reason: 'blocked_domain' };
    }

    if (CONSUMER_MAIL.has(domain)) return { allowed: false, reason: 'personal_email' };
    if (DISPOSABLE_MAIL.has(domain)) return { allowed: false, reason: 'disposable_email' };

    // Suffix match, so every subdomain of a shared namespace is covered too
    // (`cs.ox.ac.uk`, `sloan.mit.edu`). The leading dot in each suffix prevents
    // "notaschool.edu.example.com" style near-misses from matching on a bare substring.
    if (SHARED_TLD_SUFFIXES.some(suffix => domain === suffix.slice(1) || domain.endsWith(suffix))) {
        return { allowed: false, reason: 'shared_institution' };
    }

    return { allowed: true, reason: 'ok' };
}

/** Convenience predicate for call sites that do not need the reason. */
export function isSelfServeEligibleDomain(domain) {
    return classifySelfServeDomain(domain).allowed;
}

export const SELF_SERVE_DOMAIN_LISTS = { CONSUMER_MAIL, DISPOSABLE_MAIL, SHARED_TLD_SUFFIXES };
