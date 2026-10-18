/**
 * Connectors — structured sources that keyword search cannot reach.
 *
 * The rule that decides what belongs here (see the internal design log): a source is a
 * SEARCH INDEX or a DATABASE. Reviews, policy documents and press are indexed, so they
 * are steered with an include_domains allowlist in sourceTiers.js. Tenders and filings
 * are query-shaped databases — Tavily can find *an article about* a 10-K, but it cannot
 * enumerate every 8-K five competitors filed in the last 30 days, and a tender that
 * closes in 14 days is worthless found three weeks later.
 *
 * ── Why the whole implementation lives server-side ──────────────────────────────────
 * The obvious split — registry builds a URL, handler fetches it — hands a caller the
 * ability to make this server fetch arbitrary URLs. Instead the client sends only
 * `{ source, params }`; every URL is constructed here from a fixed base. There is no
 * code path where a caller-supplied string becomes a host.
 *
 * ── Verification status, 2026-08-03 ─────────────────────────────────────────────────
 * Verified against the live API:  hn, sec_edgar, contracts_finder
 * Endpoint live, needs a key:     companies_house (401 without one)
 * Unverifiable without a key:     sam_gov (gateway returns a bare 404 unauthenticated)
 * Credential requirement CHANGED: reddit now 403s every unauthenticated path, so it
 *                                 needs OAuth client credentials it did not used to
 * Best-effort scrape:             gem (no public API exists)
 */

import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';

const DEFAULT_TIMEOUT_MS = 15000;

// SEC requires a descriptive User-Agent on every automated request and blocks generic
// ones. Reddit and GeM likewise reject an unset UA.
const UA = process.env.CONNECTOR_USER_AGENT
    || 'Bahirjee Intelligence (contact: support@bahirjee.com)';

/** Fetch with a hard timeout so one slow source cannot eat the step's whole budget. */
async function fetchJson(url, { headers = {}, timeout = DEFAULT_TIMEOUT_MS, method = 'GET', body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, {
            method,
            headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
            ...(body ? { body } : {}),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const clampInt = (value, min, max, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const isoDaysAgo = (days) =>
    new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

/** US-format date (MM/DD/YYYY), which SAM.gov requires and nothing else uses. */
const usDaysAgo = (days) => {
    const d = new Date(Date.now() - days * 86400000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};

/**
 * Case-insensitive term match over a blob of text. Used by the connectors whose API
 * has no keyword filter, so relevance has to be applied after retrieval.
 */
const matchesAnyTerm = (text, terms) => {
    const haystack = String(text || '').toLowerCase();
    return terms.some(t => t && haystack.includes(String(t).toLowerCase()));
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONNECTORS
// Each exposes: { envKey, run({ query, terms, days, limit }) -> observation[] }
// An observation matches what storeObservations() expects:
//   { job, theme, source, source_type, source_class, data, url, title, published_date }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Hacker News via the Algolia index.
 *
 * Tavily indexes HN threads, but strips the two fields that make them a sentiment
 * signal at all: points and comment count. "47 comments on a competitor's launch" and
 * "2 comments" are different intelligence, and only this API distinguishes them.
 */
const hn = {
    envKey: null,
    async run({ query, days = 180, limit = 8 }) {
        const since = Math.floor((Date.now() - days * 86400000) / 1000);
        const url = 'https://hn.algolia.com/api/v1/search?'
            + new URLSearchParams({
                query,
                tags: 'story',
                numericFilters: `created_at_i>${since}`,
                hitsPerPage: String(limit),
            });

        const json = await fetchJson(url);
        return (json.hits || [])
            // A story nobody engaged with is not a discussion signal.
            .filter(h => (h.points || 0) >= 2 || (h.num_comments || 0) >= 2)
            .map(h => ({
                job: query,
                theme: 'industry_momentum',
                source: 'Hacker News',
                source_type: 'connector',
                source_class: 'social',
                url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                title: h.title || '',
                published_date: (h.created_at || '').split('T')[0] || null,
                data: `HACKER NEWS DISCUSSION\nTitle: ${h.title}\n`
                    + `Engagement: ${h.points || 0} points, ${h.num_comments || 0} comments\n`
                    + `Posted: ${h.created_at}\nLink: ${h.url || ''}\n`
                    + `Discussion: https://news.ycombinator.com/item?id=${h.objectID}\n`
                    + `Note: engagement volume is the sentiment signal here — a highly `
                    + `commented thread indicates the community considers this significant.`,
            }));
    },
};

/**
 * SEC EDGAR full-text search.
 *
 * The only route to "what did these public companies actually file, and when". Free and
 * keyless, but SEC blocks requests without a descriptive User-Agent.
 */
const sec_edgar = {
    envKey: null,
    async run({ query, days = 180, limit = 8, forms = '8-K,10-K,10-Q,S-1' }) {
        const url = 'https://efts.sec.gov/LATEST/search-index?'
            + new URLSearchParams({
                q: `"${query}"`,
                forms,
                dateRange: 'custom',
                startdt: isoDaysAgo(days),
                enddt: new Date().toISOString().split('T')[0],
            });

        const json = await fetchJson(url);
        return (json?.hits?.hits || []).slice(0, limit).map(hit => {
            const src = hit._source || {};
            const cik = (src.ciks || [])[0] || '';
            const accession = String(src.adsh || '').replace(/-/g, '');
            // _id is "accession:filename"; the archive path needs the CIK without
            // leading zeros and the accession without dashes.
            const filename = String(hit._id || '').split(':')[1] || '';
            const filingUrl = cik && accession
                ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${filename}`
                : 'https://www.sec.gov/edgar/search/';
            const filer = (src.display_names || [])[0] || 'Unknown filer';

            return {
                job: query,
                theme: 'competitor_intel',
                source: 'SEC EDGAR',
                source_type: 'connector',
                source_class: 'filing',
                url: filingUrl,
                title: `${filer} — ${src.form || 'filing'}`,
                published_date: src.file_date || null,
                data: `SEC FILING\nFiler: ${filer}\nForm: ${src.form || ''}\n`
                    + `Filed: ${src.file_date || ''}\nPeriod: ${src.period_ending || ''}\n`
                    + `Items: ${(src.items || []).join(', ') || 'n/a'}\n`
                    + `Location: ${(src.biz_locations || []).join(', ') || 'n/a'}\n`
                    + `Matched term: "${query}"\nURL: ${filingUrl}\n`
                    + `Note: this is a regulatory filing — a legally binding disclosure, `
                    + `not a press account of one.`,
            };
        });
    },
};

/**
 * UK Contracts Finder (OCDS).
 *
 * The API's `keyword` parameter is accepted and then IGNORED — a search for
 * "telehealth" returns taxi contracts. Verified 2026-08-03. Date filtering does work,
 * so the connector pulls a date window and filters in process. Silently trusting
 * `keyword` would have shipped a tender feed with no relationship to the founder.
 */
const contracts_finder = {
    envKey: null,
    async run({ terms = [], days = 30, limit = 8 }) {
        const url = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?'
            + new URLSearchParams({
                publishedFrom: isoDaysAgo(days),
                publishedTo: new Date().toISOString().split('T')[0],
                stages: 'tender',
            });

        const json = await fetchJson(url, { timeout: 25000 });
        const releases = json?.releases || [];

        return releases
            .filter(r => {
                const t = r.tender || {};
                const blob = `${t.title || ''} ${t.description || ''} `
                    + `${(t.classification?.description) || ''}`;
                return matchesAnyTerm(blob, terms);
            })
            .slice(0, limit)
            .map(r => {
                const t = r.tender || {};
                const buyer = r.buyer?.name || 'Unknown buyer';
                const value = t.value ? `${t.value.amount} ${t.value.currency}` : 'not stated';
                const closes = t.tenderPeriod?.endDate || 'not stated';
                const link = `https://www.contractsfinder.service.gov.uk/notice/${r.id || ''}`;

                return {
                    job: `UK tender: ${(terms || []).join(', ')}`,
                    theme: 'customer_shifts',
                    source: 'UK Contracts Finder',
                    source_type: 'connector',
                    source_class: 'tender',
                    url: link,
                    title: t.title || 'UK public tender',
                    published_date: (t.datePublished || r.date || '').split('T')[0] || null,
                    data: `UK PUBLIC TENDER\nTitle: ${t.title || ''}\nBuyer: ${buyer}\n`
                        + `Published: ${t.datePublished || ''}\nCloses: ${closes}\n`
                        + `Value: ${value}\nStatus: ${t.status || ''}\n`
                        + `Category: ${t.classification?.description || ''}\n`
                        + `Description: ${String(t.description || '').slice(0, 1500)}\n`
                        + `URL: ${link}\n`
                        + `Note: a live procurement — a buyer with allocated budget actively `
                        + `seeking a supplier. This is demand, not market commentary.`,
                };
            });
    },
};

/**
 * SAM.gov contract opportunities (US federal).
 *
 * Free key from sam.gov. UNVERIFIED against a live response: the gateway answers every
 * unauthenticated request with a bare 404, so neither the path nor the payload shape
 * could be confirmed without a key. Written to the published contract; treat the first
 * real run as the verification.
 */
const sam_gov = {
    envKey: 'SAM_GOV_API_KEY',
    async run({ query, days = 30, limit = 8, apiKey }) {
        const url = 'https://api.sam.gov/opportunities/v2/search?'
            + new URLSearchParams({
                api_key: apiKey,
                limit: String(limit),
                postedFrom: usDaysAgo(days),
                postedTo: usDaysAgo(0),
                title: query,
            });

        const json = await fetchJson(url, { timeout: 20000 });
        return (json?.opportunitiesData || []).slice(0, limit).map(o => ({
            job: `US tender: ${query}`,
            theme: 'customer_shifts',
            source: 'SAM.gov',
            source_type: 'connector',
            source_class: 'tender',
            url: o.uiLink || 'https://sam.gov/search',
            title: o.title || 'US federal opportunity',
            published_date: (o.postedDate || '').split('T')[0] || null,
            data: `US FEDERAL CONTRACT OPPORTUNITY\nTitle: ${o.title || ''}\n`
                + `Agency: ${o.fullParentPathName || o.department || ''}\n`
                + `Type: ${o.type || ''}\nPosted: ${o.postedDate || ''}\n`
                + `Response deadline: ${o.responseDeadLine || 'not stated'}\n`
                + `NAICS: ${o.naicsCode || ''}\nSet-aside: ${o.typeOfSetAside || 'none'}\n`
                + `Description: ${String(o.description || '').slice(0, 1500)}\n`
                + `URL: ${o.uiLink || ''}\n`
                + `Note: a live federal procurement — allocated budget, published deadline.`,
        }));
    },
};

/**
 * UK Companies House.
 *
 * The only route to a PRIVATE UK competitor's real numbers. Filing history and accounts
 * are public here and indexed nowhere a keyword search can reach. Free key; the API
 * authenticates with HTTP Basic using the key as the username and an empty password.
 */
const companies_house = {
    envKey: 'COMPANIES_HOUSE_API_KEY',
    async run({ query, limit = 8, apiKey }) {
        const auth = Buffer.from(`${apiKey}:`).toString('base64');
        const headers = { Authorization: `Basic ${auth}` };

        const search = await fetchJson(
            `https://api.company-information.service.gov.uk/search/companies?${new URLSearchParams({ q: query, items_per_page: '3' })}`,
            { headers }
        );

        const companies = (search?.items || []).slice(0, 2);
        const out = [];

        for (const company of companies) {
            const number = company.company_number;
            if (!number) continue;

            let filings = [];
            try {
                const history = await fetchJson(
                    `https://api.company-information.service.gov.uk/company/${number}/filing-history?items_per_page=5`,
                    { headers }
                );
                filings = history?.items || [];
            } catch {
                // A company with no accessible filing history is still worth reporting.
            }

            const link = `https://find-and-update.company-information.service.gov.uk/company/${number}`;
            out.push({
                job: query,
                theme: 'competitor_intel',
                source: 'Companies House',
                source_type: 'connector',
                source_class: 'filing',
                url: link,
                title: `${company.title} — UK filings`,
                published_date: filings[0]?.date || company.date_of_creation || null,
                data: `UK COMPANIES HOUSE RECORD\nCompany: ${company.title}\n`
                    + `Number: ${number}\nStatus: ${company.company_status || ''}\n`
                    + `Incorporated: ${company.date_of_creation || ''}\n`
                    + `Address: ${company.address_snippet || ''}\n`
                    + `Recent filings:\n`
                    + (filings.length
                        ? filings.map(f => `  - ${f.date}: ${f.type} — ${f.description || ''}`).join('\n')
                        : '  (none accessible)')
                    + `\nURL: ${link}\n`
                    + `Note: statutory filings for a UK company, including private ones whose `
                    + `finances appear nowhere else.`,
            });
            if (out.length >= limit) break;
        }
        return out;
    },
};

/**
 * Reddit search.
 *
 * CREDENTIAL REQUIREMENT CHANGED. Reddit's unauthenticated JSON endpoints
 * (reddit.com/search.json, old.reddit.com, oauth.reddit.com without a token) all return
 * 403 as of 2026-08-03 — verified. This now needs OAuth2 client credentials from a free
 * app registration at reddit.com/prefs/apps. Without them the connector self-disables.
 */
const reddit = {
    envKey: 'REDDIT_CLIENT_ID',
    async run({ query, days = 365, limit = 8 }) {
        const clientId = process.env.REDDIT_CLIENT_ID;
        const clientSecret = process.env.REDDIT_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            throw new Error('Reddit needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET');
        }

        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const token = await fetchJson('https://www.reddit.com/api/v1/access_token', {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        if (!token?.access_token) throw new Error('Reddit returned no access token');

        const timeWindow = days <= 31 ? 'month' : days <= 366 ? 'year' : 'all';
        const json = await fetchJson(
            `https://oauth.reddit.com/search?${new URLSearchParams({
                q: query, sort: 'relevance', t: timeWindow, limit: String(limit), type: 'link',
            })}`,
            { headers: { Authorization: `Bearer ${token.access_token}` } }
        );

        return (json?.data?.children || [])
            .map(c => c.data)
            .filter(d => d && (d.score || 0) >= 2)
            .slice(0, limit)
            .map(d => ({
                job: query,
                theme: 'customer_shifts',
                source: 'Reddit',
                source_type: 'connector',
                source_class: 'social',
                url: `https://reddit.com${d.permalink || ''}`,
                title: d.title || '',
                published_date: d.created_utc
                    ? new Date(d.created_utc * 1000).toISOString().split('T')[0]
                    : null,
                data: `REDDIT DISCUSSION\nSubreddit: r/${d.subreddit || ''}\n`
                    + `Title: ${d.title || ''}\n`
                    + `Engagement: ${d.score || 0} upvotes, ${d.num_comments || 0} comments\n`
                    + `Body: ${String(d.selftext || '').slice(0, 1200)}\n`
                    + `URL: https://reddit.com${d.permalink || ''}\n`
                    + `Note: practitioners and buyers in their own words. Upvote and comment `
                    + `counts indicate how widely the view is shared, not whether it is correct.`,
            }));
    },
};

/**
 * GeM (Government e-Marketplace, India) — best effort.
 *
 * India's public procurement portal has no public API. The bid listing is server-rendered
 * and scrapable, but the markup is not a contract and will break without warning. Failures
 * here are expected and must surface as a degradation rather than an error, per
 * the internal design log §"An AI failure must surface as a failure, never as a thin report."
 */
const gem = {
    envKey: null,
    reliability: 'best-effort',
    async run({ terms = [], limit = 8 }) {
        const url = 'https://bidplus.gem.gov.in/all-bids';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);

        let html;
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, Accept: 'text/html' },
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        } finally {
            clearTimeout(timer);
        }

        // Deliberately loose parsing. A strict selector chain against markup we do not
        // control fails on any redesign; this pulls bid identifiers and their surrounding
        // text and lets relevance filtering do the rest.
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');

        const blocks = text.split(/(?=GEM\/\d{4}\/[A-Z]?\/?\d+)/i).filter(b => /GEM\/\d{4}/i.test(b));
        if (blocks.length === 0) throw new Error('No bid blocks found — GeM markup likely changed');

        return blocks
            .filter(b => terms.length === 0 || matchesAnyTerm(b, terms))
            .slice(0, limit)
            .map(block => {
                const bidNo = (block.match(/GEM\/\d{4}\/[A-Z]?\/?\d+/i) || [''])[0];
                return {
                    job: `India tender: ${(terms || []).join(', ')}`,
                    theme: 'customer_shifts',
                    source: 'GeM (India)',
                    source_type: 'connector',
                    source_class: 'tender',
                    url: 'https://bidplus.gem.gov.in/all-bids',
                    title: `GeM bid ${bidNo}`.trim(),
                    // No reliable per-bid date in the listing. Omitted rather than guessed:
                    // a missing field is always safer than a confidently wrong one.
                    published_date: null,
                    data: `INDIA GeM PUBLIC TENDER (best-effort extraction)\n`
                        + `Bid number: ${bidNo}\nDetails: ${block.slice(0, 1200).trim()}\n`
                        + `Portal: https://bidplus.gem.gov.in/all-bids\n`
                        + `Note: a live Indian government procurement. Extracted from the public `
                        + `bid listing, which has no API — treat field-level detail as indicative `
                        + `and verify on the portal before acting.`,
                };
            });
    },
};

const CONNECTORS = { hn, sec_edgar, contracts_finder, sam_gov, companies_house, reddit, gem };

export const CONNECTOR_IDS = Object.keys(CONNECTORS);

/**
 * Run one connector, resolving its credential and swallowing its failures.
 *
 * Separated from `handler` so the fail-open contract can be tested without standing up
 * auth and rate limiting — a test that stubs global fetch to simulate a dead upstream
 * would otherwise break the Supabase call inside the auth middleware and prove nothing
 * about the connector.
 *
 * NEVER throws. Returns { source, observations, disabled?, error?, reliability }.
 */
export async function runConnector(source, params = {}) {
    const connector = CONNECTORS[source];
    if (!connector) return { source, observations: [], error: `Unknown connector: ${source}` };

    const reliability = connector.reliability || 'stable';
    const apiKey = connector.envKey ? process.env[connector.envKey] : null;

    // A connector whose key is absent is not an error — it is a source this deployment
    // has not been given access to. Say so and return nothing.
    if (connector.envKey && !apiKey) {
        return {
            source,
            observations: [],
            disabled: true,
            reason: `${connector.envKey} is not configured`,
            reliability,
        };
    }

    try {
        const observations = await connector.run({ ...params, apiKey });
        return { source, observations: Array.isArray(observations) ? observations : [], reliability };
    } catch (err) {
        console.warn(`[Connectors] ${source} failed: ${err.message}`);
        return { source, observations: [], error: err.message, reliability };
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// POST /api/connectors { source, query?, terms?, days?, limit?, forms? }
// → { observations: [...], source, disabled?, reliability? }
//
// A connector that cannot run (missing key, dead upstream) returns 200 with an empty
// observation list and a `disabled`/`error` reason. It never 500s: one unavailable
// source must not fail a run that has six other sources working.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'connectors', maxRequests: 60 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'connectors', maxRequests: 60 } })) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { source, query = '', terms = [], days, limit, forms } = req.body || {};

    if (!CONNECTORS[source]) {
        return res.status(400).json({ error: `Unknown connector: ${source}` });
    }

    const safeTerms = (Array.isArray(terms) ? terms : [])
        .map(t => String(t || '').trim())
        .filter(t => t.length >= 2)
        .slice(0, 12);

    // 200 in every case below, including failure: the caller records a degradation and
    // carries on with the other six sources.
    const result = await runConnector(source, {
        query: String(query || '').slice(0, 300),
        terms: safeTerms,
        days: clampInt(days, 1, 730, 180),
        limit: clampInt(limit, 1, 20, 8),
        forms,
    });

    return res.status(200).json(result);
}
